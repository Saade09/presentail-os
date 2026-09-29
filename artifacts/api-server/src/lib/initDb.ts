import { randomUUID } from "crypto";
import { db } from "./db";
import { logger } from "./logger";
import { objectStorageClient } from "./objectStorage";
import { backfillCmcOrderSales } from "./backfillCmcOrderSales";
import { logStartupTiming } from "./startupTiming";
import {
  VIP_SPEND_THRESHOLD_USD,
  FREE_EMAIL_DOMAINS,
  CORPORATE_KEYWORD_POSIX_RE,
} from "./autoTags";
import { reconcileCompletedFloristAssignments } from "./floristOrderCompletion";
import { backfillRealDeliveryPublications, processRealDeliveryPublications } from "./realDeliveryPublication";

/**
 * Idempotent table creation for the workspace_members table.
 * Each Clerk user belongs to exactly one workspace (their own by default).
 * The owner can invite others by email; pending invites have a NULL
 * member_user_id that gets filled in when the invitee first signs in.
 */
// Arbitrary fixed key used to serialise concurrent initDb calls across
// multiple processes that start simultaneously (e.g. production rolling
// restart). Only one process runs the migration/seed logic at a time; the
// others wait, then find everything already in place and finish quickly.
const INIT_DB_ADVISORY_LOCK_KEY = 7_432_819_001n;

/** Retention window for ingest_key_usage rows (days). Rows older than this are pruned on startup. */
const INGEST_USAGE_RETENTION_DAYS = 90;

/**
 * Duplicate empty workspace auto-created for taleb@presentail.com on May 24,
 * 2026 when he signed in before being invited (the old @presentail.com
 * auto-bootstrap behavior, since removed from claimMembership). Deleting his
 * owner membership lets the pending invite into the main workspace be claimed
 * on his next sign-in.
 */
const DUPLICATE_WORKSPACE_OWNER_ID = "user_3EBoKbIwm2kCtm6L2fWzflvnqel";

/**
 * Canonicalize the global Lebanese pound rate without overwriting its meaning.
 *
 * Provider rows store target units per base unit, while manual rows store the
 * reciprocal. The canonical pair is USD/LBP. Older deployments may have either
 * format under the reversed LBP/USD pair, or may have a canonical row written
 * using the other provider convention. This block preserves the represented
 * rate, removes the conflicting reverse pair, and only seeds the 89,500
 * fallback when no usable canonical row remains.
 *
 * Exported for real-database regression coverage.
 */
export async function repairGlobalLbpRate(): Promise<void> {
  await db.query(`
    DO $$
    DECLARE
      chosen_rate numeric;
      chosen_provider text;
      chosen_fetched_at timestamptz;
    BEGIN
      -- Choose one usable represented value across both orientations before
      -- deleting either row. A legitimate manual override wins over provider
      -- data; among rows of the same kind, the newest value wins.
      SELECT
        CASE
          WHEN provider = 'manual' THEN LEAST(rate, 1.0 / rate)
          ELSE GREATEST(rate, 1.0 / rate)
        END,
        provider,
        fetched_at
        INTO chosen_rate, chosen_provider, chosen_fetched_at
        FROM exchange_rates
       WHERE workspace_owner_id = '__global__'
         AND (
           (base_currency = 'USD' AND target_currency = 'LBP')
           OR (base_currency = 'LBP' AND target_currency = 'USD')
         )
         AND rate > 0
         -- Accept broad but plausible owner overrides: 10k–1m LBP per USD.
         AND GREATEST(rate, 1.0 / rate) BETWEEN 10000 AND 1000000
       ORDER BY
         (provider = 'manual') DESC,
         fetched_at DESC,
         (base_currency = 'USD' AND target_currency = 'LBP') DESC
       LIMIT 1;

      DELETE FROM exchange_rates
       WHERE workspace_owner_id = '__global__'
         AND (
           (base_currency = 'USD' AND target_currency = 'LBP')
           OR (base_currency = 'LBP' AND target_currency = 'USD')
         );

      IF chosen_rate IS NOT NULL THEN
        INSERT INTO exchange_rates
          (workspace_owner_id, base_currency, target_currency, rate, provider, fetched_at)
        VALUES (
          '__global__',
          'USD',
          'LBP',
          chosen_rate,
          chosen_provider,
          chosen_fetched_at
        );
      ELSE
        INSERT INTO exchange_rates
          (workspace_owner_id, base_currency, target_currency, rate, provider, fetched_at)
        VALUES ('__global__', 'USD', 'LBP', 1.0 / 89500, 'manual', now());
      END IF;
    END $$;
  `);
}
/**
 * One-time, idempotent startup cleanup: delete workspace_members rows for the
 * duplicate auto-created workspace above. As a safety guard the delete only
 * runs when the workspace has NO rows in key data tables (orders, products,
 * locations) — verified empty in production, and the guard keeps the cleanup
 * safe to re-run on every startup in both dev and prod. A no-op when the row
 * doesn't exist (e.g. dev databases).
 *
 * Exported for testing; invoked from initDb() after all tables exist.
 */
export async function cleanupDuplicatePresentailWorkspace(): Promise<void> {
  const result = await db.query(
    `DELETE FROM workspace_members
      WHERE workspace_owner_id = $1
        AND NOT EXISTS (SELECT 1 FROM orders    WHERE workspace_owner_id = $1)
        AND NOT EXISTS (SELECT 1 FROM products  WHERE workspace_owner_id = $1)
        AND NOT EXISTS (SELECT 1 FROM locations WHERE workspace_owner_id = $1)`,
    [DUPLICATE_WORKSPACE_OWNER_ID],
  );
  if (result.rowCount && result.rowCount > 0) {
    logger.info(
      { workspaceOwnerId: DUPLICATE_WORKSPACE_OWNER_ID, deleted: result.rowCount },
      "duplicate-workspace cleanup: deleted workspace_members row(s) for the duplicate auto-created workspace",
    );
  }
}

export async function initDb(): Promise<void> {
  const initDbStartedAt = Date.now();
  let initDbSucceeded = false;
  logStartupTiming("database_initialization", "start", initDbStartedAt);
  // Keep the serialization lock on a dedicated transaction. A session-level
  // lock acquired through Pool.query() can be held by one pooled connection
  // while the matching unlock runs on another connection, leaving the first
  // connection locked after an exception.
  const initLockClient = await db.connect();
  let initLockTransactionStarted = false;
  let destroyInitLockClient = false;
  try {
    await initLockClient.query("BEGIN");
    initLockTransactionStarted = true;
    await initLockClient.query(
      `SELECT pg_advisory_xact_lock($1)`,
      [INIT_DB_ADVISORY_LOCK_KEY]
    );
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_usage_log (
      id               BIGSERIAL PRIMARY KEY,
      action_key       TEXT NOT NULL,
      surface          TEXT NOT NULL,
      provider         TEXT NOT NULL,
      model_id         TEXT NOT NULL,
      key_source       TEXT NOT NULL,
      was_fallback     BOOLEAN NOT NULL DEFAULT FALSE,
      input_tokens     INTEGER,
      output_tokens    INTEGER,
      cached_tokens    INTEGER,
      reasoning_tokens INTEGER,
      cost_usd         NUMERIC(12,6),
      cost_source      TEXT CHECK (cost_source IN ('provider_billed', 'estimated')),
      image_size       TEXT,
      image_quality    TEXT,
      latency_ms       INTEGER,
      success          BOOLEAN NOT NULL,
      error_code       TEXT,
      order_id         TEXT,
      session_id       TEXT,
      country          TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE ai_usage_log
      ADD COLUMN IF NOT EXISTS cost_source TEXT,
      ADD COLUMN IF NOT EXISTS image_size TEXT,
      ADD COLUMN IF NOT EXISTS image_quality TEXT;

    DO $$ BEGIN
      ALTER TABLE ai_usage_log
        ADD CONSTRAINT ai_usage_log_cost_source_check
        CHECK (cost_source IN ('provider_billed', 'estimated'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_ai_usage_created
      ON ai_usage_log (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_ai_usage_action
      ON ai_usage_log (action_key, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_ai_usage_order
      ON ai_usage_log (order_id)
      WHERE order_id IS NOT NULL;
  `);

  // Durable product-gallery queue. Draft assets stay private until approval.
  await db.query(`
    CREATE TABLE IF NOT EXISTS product_gallery_runs (
      id bigserial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      product_id integer NOT NULL,
      idempotency_key text NOT NULL,
      selected_types text[] NOT NULL,
      source_path text NOT NULL,
      source_version text NOT NULL,
      product_snapshot jsonb NOT NULL,
      model text NOT NULL,
      quality text NOT NULL,
      output_size text NOT NULL,
      output_format text NOT NULL,
      prompt_version text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      lease_token text,
      lease_until timestamptz,
      error jsonb,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT pgr_status CHECK (
        status IN ('PENDING','RUNNING','RETRY_WAITING','COMPLETED','PARTIAL','FAILED')
      ),
      CONSTRAINT pgr_gallery_types CHECK (
        selected_types <@ ARRAY[
          'alternative_composition','close_up_details','lifestyle_setting','hand_held_scale'
        ]::text[] AND cardinality(selected_types) BETWEEN 1 AND 4
      )
    );
    ALTER TABLE product_gallery_runs ADD COLUMN IF NOT EXISTS product_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE product_gallery_runs ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'gpt-image-2';
    ALTER TABLE product_gallery_runs ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'medium';
    ALTER TABLE product_gallery_runs ADD COLUMN IF NOT EXISTS output_size text NOT NULL DEFAULT '1024x1024';
    ALTER TABLE product_gallery_runs ADD COLUMN IF NOT EXISTS output_format text NOT NULL DEFAULT 'webp';
    ALTER TABLE product_gallery_runs ADD COLUMN IF NOT EXISTS prompt_version text NOT NULL DEFAULT 'product-gallery-fidelity-v1';
    ALTER TABLE product_gallery_runs ADD COLUMN IF NOT EXISTS lease_token text;
    ALTER TABLE product_gallery_runs ADD COLUMN IF NOT EXISTS error jsonb;
    ALTER TABLE product_gallery_runs ADD COLUMN IF NOT EXISTS completed_at timestamptz;
    ALTER TABLE product_gallery_runs DROP CONSTRAINT IF EXISTS pgr_status;
    ALTER TABLE product_gallery_runs ADD CONSTRAINT pgr_status CHECK (
      status IN ('PENDING','RUNNING','RETRY_WAITING','COMPLETED','PARTIAL','FAILED')
    );
    ALTER TABLE product_gallery_runs DROP CONSTRAINT IF EXISTS pgr_gallery_types;
    ALTER TABLE product_gallery_runs ADD CONSTRAINT pgr_gallery_types CHECK (
      selected_types <@ ARRAY[
        'alternative_composition','close_up_details','lifestyle_setting','hand_held_scale'
      ]::text[] AND cardinality(selected_types) BETWEEN 1 AND 4
    );
    DROP INDEX IF EXISTS idx_pgr_active_product;
    DROP INDEX IF EXISTS idx_pgr_worker;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pgr_idempotency
      ON product_gallery_runs(workspace_owner_id, product_id, idempotency_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pgr_active_product_source
      ON product_gallery_runs(workspace_owner_id, product_id, source_version)
      WHERE status IN ('PENDING','RUNNING','RETRY_WAITING');
    CREATE INDEX IF NOT EXISTS idx_pgr_product_history
      ON product_gallery_runs(workspace_owner_id, product_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS product_gallery_candidates (
      id bigserial PRIMARY KEY,
      run_id bigint NOT NULL REFERENCES product_gallery_runs(id) ON DELETE CASCADE,
      gallery_type text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      image_path text,
      source_path text NOT NULL,
      source_version text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      retry_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz,
      lease_token text,
      lease_until timestamptz,
      error jsonb,
      usage jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      generated_at timestamptz,
      reviewed_at timestamptz,
      reviewed_by text,
      CONSTRAINT pgc_status CHECK (
        status IN ('PENDING','PROCESSING','RETRY_WAITING','DRAFT','APPROVED','REJECTED','STALE','FAILED','DELETED')
      ),
      CONSTRAINT pgc_gallery_type CHECK (
        gallery_type IN ('alternative_composition','close_up_details','lifestyle_setting','hand_held_scale')
      ),
      CONSTRAINT pgc_run_type UNIQUE(run_id, gallery_type)
    );
    ALTER TABLE product_gallery_candidates ADD COLUMN IF NOT EXISTS source_path text;
    UPDATE product_gallery_candidates c
       SET source_path=r.source_path
      FROM product_gallery_runs r
     WHERE c.run_id=r.id AND c.source_path IS NULL;
    ALTER TABLE product_gallery_candidates ALTER COLUMN source_path SET NOT NULL;
    ALTER TABLE product_gallery_candidates ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
    ALTER TABLE product_gallery_candidates ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;
    ALTER TABLE product_gallery_candidates ADD COLUMN IF NOT EXISTS lease_token text;
    ALTER TABLE product_gallery_candidates ADD COLUMN IF NOT EXISTS lease_until timestamptz;
    ALTER TABLE product_gallery_candidates ADD COLUMN IF NOT EXISTS error jsonb;
    ALTER TABLE product_gallery_candidates ADD COLUMN IF NOT EXISTS usage jsonb;
    ALTER TABLE product_gallery_candidates ADD COLUMN IF NOT EXISTS generated_at timestamptz;
    ALTER TABLE product_gallery_candidates DROP CONSTRAINT IF EXISTS pgc_status;
    ALTER TABLE product_gallery_candidates ADD CONSTRAINT pgc_status CHECK (
      status IN ('PENDING','PROCESSING','RETRY_WAITING','DRAFT','APPROVED','REJECTED','STALE','FAILED','DELETED')
    );
    ALTER TABLE product_gallery_candidates DROP CONSTRAINT IF EXISTS pgc_gallery_type;
    ALTER TABLE product_gallery_candidates ADD CONSTRAINT pgc_gallery_type CHECK (
      gallery_type IN ('alternative_composition','close_up_details','lifestyle_setting','hand_held_scale')
    );
    DROP INDEX IF EXISTS idx_pgc_run;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pgc_run_type
      ON product_gallery_candidates(run_id, gallery_type);
    CREATE INDEX IF NOT EXISTS idx_pgc_due
      ON product_gallery_candidates(status, next_attempt_at, lease_until);

    CREATE TABLE IF NOT EXISTS product_gallery_attempts (
      id bigserial PRIMARY KEY,
      candidate_id bigint NOT NULL REFERENCES product_gallery_candidates(id) ON DELETE CASCADE,
      attempt_number integer NOT NULL,
      status text NOT NULL,
      model text NOT NULL,
      prompt text NOT NULL,
      prompt_version text NOT NULL,
      config jsonb NOT NULL,
      error jsonb,
      usage jsonb,
      lease_token text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT pga_candidate_attempt UNIQUE(candidate_id, attempt_number)
    );
    ALTER TABLE product_gallery_attempts ALTER COLUMN lease_token DROP DEFAULT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pga_candidate_attempt
      ON product_gallery_attempts(candidate_id, attempt_number);

    CREATE TABLE IF NOT EXISTS product_gallery_audit_events (
      id bigserial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      product_id integer NOT NULL,
      run_id bigint,
      candidate_id bigint,
      event_type text NOT NULL,
      actor_id text,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE product_gallery_audit_events ADD COLUMN IF NOT EXISTS run_id bigint;
    ALTER TABLE product_gallery_audit_events ADD COLUMN IF NOT EXISTS event_type text;
    DO $gallery_audit_drop_fks$
    DECLARE
      constraint_name text;
    BEGIN
      FOR constraint_name IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid='product_gallery_audit_events'::regclass
           AND contype='f'
      LOOP
        EXECUTE format(
          'ALTER TABLE product_gallery_audit_events DROP CONSTRAINT %I',
          constraint_name
        );
      END LOOP;
    END
    $gallery_audit_drop_fks$;
    DO $gallery_audit_migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name='product_gallery_audit_events' AND column_name='action'
      ) THEN
        EXECUTE 'UPDATE product_gallery_audit_events SET event_type=action WHERE event_type IS NULL';
        EXECUTE 'ALTER TABLE product_gallery_audit_events ALTER COLUMN action DROP NOT NULL';
      END IF;
    END
    $gallery_audit_migration$;
    ALTER TABLE product_gallery_audit_events ALTER COLUMN event_type SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pgae_product
      ON product_gallery_audit_events(workspace_owner_id, product_id, created_at DESC);
    CREATE OR REPLACE FUNCTION product_gallery_audit_events_immutable()
    RETURNS trigger AS $gallery_audit_immutable$
    BEGIN
      RAISE EXCEPTION 'product_gallery_audit_events is append-only';
    END;
    $gallery_audit_immutable$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_product_gallery_audit_events_immutable
      ON product_gallery_audit_events;
    CREATE TRIGGER trg_product_gallery_audit_events_immutable
      BEFORE UPDATE OR DELETE ON product_gallery_audit_events
      FOR EACH ROW EXECUTE FUNCTION product_gallery_audit_events_immutable();
  `);
  logger.info("product_gallery tables ready");
  await db.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      name text NOT NULL DEFAULT 'Unnamed device',
      machine_id text NOT NULL,
      os text,
      agent_version text,
      printers jsonb NOT NULL DEFAULT '[]',
      last_seen_at timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now(),
      CONSTRAINT devices_user_machine_unique UNIQUE (user_id, machine_id)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'devices'
            AND indexname  = 'idx_devices_user'
       ) AS exists`,
    );
    await db.query(`CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);`);
    if (existsBefore.rows[0].exists) {
      logger.info("idx_devices_user: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_devices_user: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("devices table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      device_id integer REFERENCES devices(id) ON DELETE SET NULL,
      device_name text,
      printer_name text,
      file_name text NOT NULL,
      copies integer NOT NULL DEFAULT 1,
      pdf_data bytea,
      status text NOT NULL DEFAULT 'pending',
      error text,
      pages integer NOT NULL DEFAULT 0,
      created_at timestamptz DEFAULT now(),
      claimed_at timestamptz,
      completed_at timestamptz
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'print_jobs'
            AND indexname  = 'idx_pj_user'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_pj_user ON print_jobs(user_id, created_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_pj_user: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_pj_user: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("print_jobs table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS workspace_members (
      id serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      member_user_id text,
      member_email text NOT NULL,
      role text NOT NULL DEFAULT 'member',
      invited_by_user_id text,
      invited_by_email text,
      created_at timestamptz DEFAULT now(),
      joined_at timestamptz,
      CONSTRAINT workspace_members_email_unique
        UNIQUE (workspace_owner_id, member_email)
    );

    CREATE TABLE IF NOT EXISTS apple_identities (
      apple_subject text PRIMARY KEY,
      clerk_user_id text NOT NULL UNIQUE,
      linked_email text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_signed_in_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_apple_identities_clerk_user
      ON apple_identities(clerk_user_id);

    CREATE TABLE IF NOT EXISTS apple_auth_challenges (
      nonce_hash text PRIMARY KEY,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_apple_auth_challenges_expiry
      ON apple_auth_challenges(expires_at);

    CREATE TABLE IF NOT EXISTS mobile_auth_sessions (
      id              text PRIMARY KEY,
      clerk_user_id   text NOT NULL,
      user_updated_at numeric(20, 0) NOT NULL,
      expires_at      timestamptz NOT NULL,
      revoked_at      timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_auth_sessions_user
      ON mobile_auth_sessions(clerk_user_id);
    CREATE INDEX IF NOT EXISTS idx_mobile_auth_sessions_expiry
      ON mobile_auth_sessions(expires_at);
  `);
  // A given Clerk user can be a joined member of at most ONE workspace.
  // Pending invites (member_user_id IS NULL) are exempt — multiple workspaces
  // can have a pending invite for the same email; only one will get claimed.
  await db.query(`DROP INDEX IF EXISTS idx_wm_member_user;`);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'workspace_members'
            AND indexname  = 'idx_wm_unique_member'
       ) AS exists`,
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_unique_member
         ON workspace_members(member_user_id)
         WHERE member_user_id IS NOT NULL;`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_wm_unique_member: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_wm_unique_member: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'workspace_members'
            AND indexname  = 'idx_wm_owner'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_wm_owner
         ON workspace_members(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_wm_owner: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_wm_owner: was missing — created successfully (deployment migrated)");
    }
  }
  // Emergency contact columns — nullable, private to profile owner / owners / admins.
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS ec_name text;`);
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS ec_relationship text;`);
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS ec_phone_country_code text;`);
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS ec_phone text;`);
  // Security notification preference — users can opt out of new-sign-in emails.
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS notify_email_on_new_sign_in boolean NOT NULL DEFAULT true;`);
  // Email preferences — per-user opt-outs for staff new-order emails and the weekly digest.
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS notify_email_on_new_order boolean NOT NULL DEFAULT true;`);
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS notify_email_weekly_digest boolean NOT NULL DEFAULT true;`);
  logger.info("workspace_members table ready");

  // Known user devices — tracks device fingerprints per Clerk user to detect new sign-ins.
  await db.query(`
    CREATE TABLE IF NOT EXISTS known_user_devices (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      device_fingerprint text NOT NULL,
      first_seen_at timestamptz DEFAULT now(),
      CONSTRAINT known_user_devices_user_device_unique UNIQUE (user_id, device_fingerprint)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'known_user_devices'
            AND indexname  = 'idx_known_devices_user'
       ) AS exists`,
    );
    await db.query(`CREATE INDEX IF NOT EXISTS idx_known_devices_user ON known_user_devices(user_id);`);
    if (existsBefore.rows[0].exists) {
      logger.info("idx_known_devices_user: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_known_devices_user: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("known_user_devices table ready");

  // Known user countries — tracks countries per Clerk user to detect unexpected-country sign-ins.
  await db.query(`
    CREATE TABLE IF NOT EXISTS known_user_countries (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      country text NOT NULL,
      first_seen_at timestamptz DEFAULT now(),
      CONSTRAINT known_user_countries_user_country_unique UNIQUE (user_id, country)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'known_user_countries'
            AND indexname  = 'idx_known_countries_user'
       ) AS exists`,
    );
    await db.query(`CREATE INDEX IF NOT EXISTS idx_known_countries_user ON known_user_countries(user_id);`);
    if (existsBefore.rows[0].exists) {
      logger.info("idx_known_countries_user: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_known_countries_user: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("known_user_countries table ready");

  // Cooldown column — tracks when the last unexpected-country alert email was sent per member.
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS last_country_alert_at timestamptz;`);
  logger.info("workspace_members.last_country_alert_at column ready");

  // api_keys table — stores hashed bearer tokens for agent/API access.
  await db.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      name text NOT NULL DEFAULT 'Untitled key',
      key_hash text NOT NULL,
      key_prefix text NOT NULL,
      created_at timestamptz DEFAULT now(),
      last_used_at timestamptz
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'api_keys'
            AND indexname  = 'idx_api_keys_user'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_api_keys_user: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_api_keys_user: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'api_keys'
            AND indexname  = 'idx_api_keys_hash'
       ) AS exists`,
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_api_keys_hash: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_api_keys_hash: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("api_keys table ready");

  // Remote-printing columns on print_jobs.
  // All are idempotent ADD COLUMN IF NOT EXISTS so safe to re-run.
  await db.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS pdf_data bytea;`);
  await db.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS copies integer NOT NULL DEFAULT 1;`);
  await db.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS claimed_at timestamptz;`);
  // Index so the agent poll query is fast even with many pending jobs.
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'print_jobs'
            AND indexname  = 'idx_pj_pending_device'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_pj_pending_device
         ON print_jobs(device_id, status)
         WHERE status = 'pending';`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_pj_pending_device: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_pj_pending_device: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("print_jobs remote-printing columns ready");

  // Soft-delete support: mark jobs as deleted rather than hard-deleting,
  // so a brief undo window can restore them.
  await db.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`);
  logger.info("print_jobs soft-delete column ready");

  // One-time startup cleanup: permanently delete any soft-deleted jobs that
  // have been in limbo for more than 10 minutes (i.e. the undo window has
  // long since expired and the browser tab was closed before the 5-second
  // timer could fire the hard-delete).
  const cleanupResult = await db.query(`
    DELETE FROM print_jobs
    WHERE deleted_at IS NOT NULL
      AND deleted_at < now() - INTERVAL '10 minutes';
  `);
  if (cleanupResult.rowCount && cleanupResult.rowCount > 0) {
    logger.info(
      `soft-delete cleanup: permanently removed ${cleanupResult.rowCount} abandoned soft-deleted job(s)`,
    );
  } else {
    logger.info("soft-delete cleanup: no abandoned soft-deleted jobs found");
  }

  // Brands — organizational containers for sticker designs.
  await db.query(`
    CREATE TABLE IF NOT EXISTS brands (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      created_at          timestamptz DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'brands'
            AND indexname  = 'idx_brands_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_brands_workspace
         ON brands(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_brands_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_brands_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  // Add logo columns if they don't exist yet.
  await db.query(`ALTER TABLE brands ADD COLUMN IF NOT EXISTS logo_data bytea;`);
  await db.query(`ALTER TABLE brands ADD COLUMN IF NOT EXISTS logo_mime text;`);
  // Add description and target_cogs columns if they don't exist yet.
  await db.query(`ALTER TABLE brands ADD COLUMN IF NOT EXISTS description text;`);
  await db.query(`ALTER TABLE brands ADD COLUMN IF NOT EXISTS target_cogs numeric(5,2);`);
  // Add card message columns if they don't exist yet.
  await db.query(`ALTER TABLE brands ADD COLUMN IF NOT EXISTS card_message_data bytea;`);
  await db.query(`ALTER TABLE brands ADD COLUMN IF NOT EXISTS card_message_mime text;`);
  // Add updated_at column so the Brands table can show real "Last Updated" timestamps.
  await db.query(`ALTER TABLE brands ADD COLUMN IF NOT EXISTS updated_at timestamptz;`);
  logger.info("brands table ready");

  // Stickers — designer-managed PDF assets stored per workspace.
  await db.query(`
    CREATE TABLE IF NOT EXISTS stickers (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      file_name           text NOT NULL,
      pdf_data            bytea NOT NULL,
      created_at          timestamptz DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'stickers'
            AND indexname  = 'idx_stickers_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_stickers_workspace
         ON stickers(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_stickers_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_stickers_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  // Add brand_id FK column to stickers (nullable in DB — enforced at API layer for new uploads).
  await db.query(`
    ALTER TABLE stickers
      ADD COLUMN IF NOT EXISTS brand_id integer REFERENCES brands(id) ON DELETE SET NULL;
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'stickers'
            AND indexname  = 'idx_stickers_brand'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_stickers_brand
         ON stickers(brand_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_stickers_brand: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_stickers_brand: was missing — created successfully (deployment migrated)");
    }
  }
  // Add thumbnail columns to stickers (nullable — existing rows unaffected).
  await db.query(`ALTER TABLE stickers ADD COLUMN IF NOT EXISTS thumbnail_data bytea;`);
  await db.query(`ALTER TABLE stickers ADD COLUMN IF NOT EXISTS thumbnail_mime text;`);
  logger.info("stickers table ready");

  // Workspace settings — per-workspace configuration.
  await db.query(`
    CREATE TABLE IF NOT EXISTS workspace_settings (
      workspace_owner_id              text PRIMARY KEY,
      offline_alert_threshold_minutes integer NOT NULL DEFAULT 5,
      offline_alert_email_enabled     boolean NOT NULL DEFAULT false
    );
  `);
  logger.info("workspace_settings table ready");

  // Storefront config — global singleton pointing at the workspace that powers
  // the public storefront (homepage banners, etc.). Exactly one row (id = 1).
  // The public storefront endpoint resolves the workspace from here first and
  // falls back to the STOREFRONT_WORKSPACE_OWNER_ID env var when unset.
  await db.query(`
    CREATE TABLE IF NOT EXISTS storefront_config (
      id                 integer PRIMARY KEY DEFAULT 1,
      workspace_owner_id text,
      updated_by         text,
      updated_at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT storefront_config_singleton CHECK (id = 1)
    );
  `);
  logger.info("storefront_config table ready");

  // Track when an offline alert email was last sent per device.
  await db.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS offline_alert_sent_at timestamptz;
  `);
  logger.info("devices.offline_alert_sent_at column ready");

  // Download events — tracks when a user downloads a client installer.
  await db.query(`
    CREATE TABLE IF NOT EXISTS download_events (
      id          serial PRIMARY KEY,
      user_id     text NOT NULL,
      platform    text NOT NULL,
      created_at  timestamptz DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'download_events'
            AND indexname  = 'idx_download_events_user'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_download_events_user ON download_events(user_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_download_events_user: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_download_events_user: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("download_events table ready");

  // Locations — Points of Sale for organizing devices.
  await db.query(`
    CREATE TABLE IF NOT EXISTS locations (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      country             text NOT NULL DEFAULT 'Lebanon',
      created_at          timestamptz DEFAULT now()
    );
  `);
  // Migrate existing `type` column → `country` if it hasn't been renamed yet.
  await db.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'locations' AND column_name = 'type'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'locations' AND column_name = 'country'
      ) THEN
        ALTER TABLE locations RENAME COLUMN type TO country;
      END IF;
    END $$;
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'locations'
            AND indexname  = 'idx_locations_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_locations_workspace
         ON locations(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_locations_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_locations_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("locations table ready");

  // Add location_type column if it doesn't exist yet.
  await db.query(`
    ALTER TABLE locations
      ADD COLUMN IF NOT EXISTS location_type text NOT NULL DEFAULT 'Point of Sale';
  `);

  // Add location_id FK to devices (nullable — unassigned = no location).
  await db.query(`
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS location_id integer
      REFERENCES locations(id) ON DELETE SET NULL;
  `);
  logger.info("devices.location_id column ready");

  // One-time data fix: early workspaces bootstrapped the owner row with role
  // 'customer_service_agent' instead of 'owner'.  This idempotent UPDATE
  // corrects any affected rows so existing users get the right permissions.
  const fixResult = await db.query(`
    UPDATE workspace_members
       SET role = 'owner'
     WHERE workspace_owner_id = member_user_id
       AND role = 'customer_service_agent';
  `);
  if (fixResult.rowCount && fixResult.rowCount > 0) {
    logger.info(
      `permissions-fix: corrected ${fixResult.rowCount} owner row(s) from 'customer_service_agent' to 'owner'`,
    );
  } else {
    logger.info("permissions-fix: no rows needed correction");
  }

  // Custom roles — per-workspace named roles with allowed page lists.
  await db.query(`
    CREATE TABLE IF NOT EXISTS workspace_roles (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      allowed_pages       jsonb NOT NULL DEFAULT '[]',
      created_at          timestamptz DEFAULT now(),
      CONSTRAINT workspace_roles_name_workspace UNIQUE (workspace_owner_id, name)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'workspace_roles'
            AND indexname  = 'idx_workspace_roles_owner'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_roles_owner
         ON workspace_roles(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_workspace_roles_owner: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_workspace_roles_owner: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("workspace_roles table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS init_db_data_migrations (
      key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // The Generate Invoice page was retired, but older custom roles may still
  // contain its page key. Remove that obsolete grant once so editing those
  // roles can succeed under the current page-key validator.
  const retiredGenerateInvoicePage = await db.query(`
    WITH claimed AS (
      INSERT INTO init_db_data_migrations (key)
      VALUES ('remove-generate-invoice-page-v1')
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    )
    UPDATE workspace_roles wr
       SET allowed_pages = COALESCE((
         SELECT jsonb_agg(to_jsonb(page) ORDER BY ord)
           FROM jsonb_array_elements_text(wr.allowed_pages)
                WITH ORDINALITY AS entries(page, ord)
          WHERE page <> 'generate-invoice'
       ), '[]'::jsonb)
     WHERE EXISTS (SELECT 1 FROM claimed)
       AND wr.allowed_pages @> '["generate-invoice"]'::jsonb
     RETURNING wr.id;
  `);
  if (retiredGenerateInvoicePage.rowCount && retiredGenerateInvoicePage.rowCount > 0) {
    logger.info(
      `permissions-fix: removed retired 'generate-invoice' from ${retiredGenerateInvoicePage.rowCount} role(s)`,
    );
  } else {
    logger.info("permissions-fix: no retired generate-invoice grants needed removal");
  }

  // CMC page-permission split (Aug 2026): before these page keys existed,
  // `cmc-pos` and any `cmc_pos.*` permission made both the dashboard and New
  // Order workflows available. Backfill both new keys for those existing roles
  // so introducing independent grants does not remove anyone's access.
  //
  // Claiming the migration key and updating roles happen atomically in one
  // statement. Later startups skip the update, which is essential: after this
  // upgrade, an owner may intentionally remove either new permission without
  // it being silently restored on restart.
  const cmcPageAccessUpgrade = await db.query(`
    WITH claimed AS (
      INSERT INTO init_db_data_migrations (key)
      VALUES ('cmc-pos-page-permissions-v1')
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    )
    UPDATE workspace_roles wr
      SET allowed_pages = (
        SELECT jsonb_agg(to_jsonb(page) ORDER BY first_seen)
          FROM (
            SELECT page, MIN(ord) AS first_seen
              FROM (
                SELECT existing.page, existing.ord
                  FROM jsonb_array_elements_text(wr.allowed_pages)
                       WITH ORDINALITY AS existing(page, ord)
                UNION ALL
                SELECT 'cmc-pos-dashboard', 2147483646
                UNION ALL
                SELECT 'cmc-pos-new-order', 2147483647
              ) AS entries
             GROUP BY page
          ) AS deduplicated
      )
     WHERE EXISTS (SELECT 1 FROM claimed)
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(wr.allowed_pages) AS existing(page)
          WHERE existing.page = 'cmc-pos'
             OR existing.page LIKE 'cmc_pos.%'
       );
  `);
  if (cmcPageAccessUpgrade.rowCount && cmcPageAccessUpgrade.rowCount > 0) {
    logger.info(
      `cmc-page-permission-upgrade: granted dashboard and new-order access to ${cmcPageAccessUpgrade.rowCount} legacy role(s)`,
    );
  } else {
    logger.info("cmc-page-permission-upgrade: no legacy roles needed update");
  }

  // Invoice Scanners page-permission split (Sep 2026): the scanner settings
  // page previously used the broad `devices` grant. Backfill the independent
  // key for existing roles that carry `devices` so this change does not remove
  // access from any member. Claiming the migration and updating roles happen
  // atomically; after the first run, later role edits can remove the scanner
  // permission without it being restored on every startup.
  const invoiceScannersPageAccessUpgrade = await db.query(`
    WITH claimed AS (
      INSERT INTO init_db_data_migrations (key)
      VALUES ('invoice-scanners-page-permission-v1')
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    )
    UPDATE workspace_roles wr
      SET allowed_pages = (
        SELECT jsonb_agg(to_jsonb(page) ORDER BY first_seen)
          FROM (
            SELECT page, MIN(ord) AS first_seen
              FROM (
                SELECT existing.page, existing.ord
                  FROM jsonb_array_elements_text(wr.allowed_pages)
                       WITH ORDINALITY AS existing(page, ord)
                UNION ALL
                SELECT 'invoice-scanners', 2147483647
              ) AS entries
             GROUP BY page
          ) AS deduplicated
      )
     WHERE EXISTS (SELECT 1 FROM claimed)
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(wr.allowed_pages) AS existing(page)
          WHERE existing.page = 'devices'
       );
  `);
  if (invoiceScannersPageAccessUpgrade.rowCount && invoiceScannersPageAccessUpgrade.rowCount > 0) {
    logger.info(
      `invoice-scanners-page-permission-upgrade: granted invoice-scanners access to ${invoiceScannersPageAccessUpgrade.rowCount} legacy role(s)`,
    );
  } else {
    logger.info("invoice-scanners-page-permission-upgrade: no legacy roles needed update");
  }

  // Add description column to workspace_roles (nullable text — optional role description).
  await db.query(`ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS description text;`);
  logger.info("workspace_roles.description column ready");

  // Retire the "Workshop Sales" page/permission from workspace_roles.allowed_pages.
  // The Workshop Sales dashboard page was removed; its page keys ("workshop-sales" and
  // "workshop_sales.*") were also removed from the shared @workspace/page-keys catalog,
  // so the frontend's strict allowedPages schema would reject any role that still lists
  // them. Strip those keys from any role that still carries them (idempotent — a no-op
  // once cleaned up). This does not touch the workshop_sales.* DB tables or API routes,
  // which remain intentionally intact for historical revenue reporting.
  const workshopPermsCleanup = await db.query(
    `UPDATE workspace_roles
        SET allowed_pages = COALESCE(
          (SELECT jsonb_agg(elem)
             FROM jsonb_array_elements_text(allowed_pages) AS elem
            WHERE elem <> 'workshop-sales'
              AND elem NOT LIKE 'workshop\\_sales.%' ESCAPE '\\'),
          '[]'::jsonb
        )
      WHERE allowed_pages::text LIKE '%workshop%'`,
  );
  if (workshopPermsCleanup.rowCount && workshopPermsCleanup.rowCount > 0) {
    logger.info(
      `workshop-sales-permission-cleanup: stripped retired workshop-sales page keys from ${workshopPermsCleanup.rowCount} role(s)`,
    );
  } else {
    logger.info("workshop-sales-permission-cleanup: no roles needed cleanup");
  }

  // Add updated_at column to workspace_roles so the UI can show "Updated N ago".
  await db.query(`
    ALTER TABLE workspace_roles
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  `);
  logger.info("workspace_roles.updated_at column ready");

  // Add is_default flag to workspace_roles so workspaces can designate which
  // role new members receive automatically (at most one per workspace).
  await db.query(`ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;`);
  logger.info("workspace_roles.is_default column ready");

  // Add custom_role_id FK column to workspace_members (nullable).
  await db.query(`
    ALTER TABLE workspace_members
      ADD COLUMN IF NOT EXISTS custom_role_id integer REFERENCES workspace_roles(id) ON DELETE SET NULL;
  `);
  logger.info("workspace_members.custom_role_id column ready");

  // Junction table for multi-role support: one member can hold multiple custom roles.
  await db.query(`
    CREATE TABLE IF NOT EXISTS workspace_member_roles (
      member_id INTEGER NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      role_id   INTEGER NOT NULL REFERENCES workspace_roles(id)   ON DELETE CASCADE,
      PRIMARY KEY (member_id, role_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wmr_member_id ON workspace_member_roles(member_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wmr_role_id   ON workspace_member_roles(role_id);`);
  // Data migration: copy existing single-role assignments into the junction table.
  await db.query(`
    INSERT INTO workspace_member_roles (member_id, role_id)
    SELECT id, custom_role_id
      FROM workspace_members
     WHERE custom_role_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  `);
  logger.info("workspace_member_roles junction table ready");

  // Birthday and gender fields on workspace_members.
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS birthday date;`);
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS gender text;`);
  logger.info("workspace_members birthday/gender columns ready");

  // Work schedule — stores which days of the week the employee normally works.
  // NULL means the Mon–Fri default; explicit JSON overrides it.
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS working_days jsonb;`);
  logger.info("workspace_members.working_days column ready");

  // Migrate existing designer / customer_service_agent rows:
  // 1. For each distinct (workspace_owner_id, legacy_role) pair, seed a workspace_role row.
  // 2. Update workspace_members.custom_role_id to point to the new role.
  // 3. Set role = 'member' on those rows so the column only holds 'owner' or 'member'.
  const legacyRows = await db.query<{
    workspace_owner_id: string;
    role: string;
  }>(
    `SELECT DISTINCT workspace_owner_id, role
       FROM workspace_members
      WHERE role IN ('designer', 'customer_service_agent')`,
  );

  const ALL_PAGES = [
    'devices',
    'invoice-scanners',
    'stickers',
    'downloads',
    'print-history',
    'analytics',
    'users',
    'api-docs',
  ];

  const LEGACY_NAMES: Record<string, string> = {
    designer: 'Designer',
    customer_service_agent: 'Customer Service Agent',
  };

  for (const row of legacyRows.rows) {
    const roleName = LEGACY_NAMES[row.role] ?? row.role;
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO workspace_roles (workspace_owner_id, name, allowed_pages)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_owner_id, name) DO NOTHING
       RETURNING id`,
      [row.workspace_owner_id, roleName, JSON.stringify(ALL_PAGES)],
    );
    let roleId: number;
    if (inserted.rows[0]) {
      roleId = inserted.rows[0].id;
    } else {
      const found = await db.query<{ id: number }>(
        `SELECT id FROM workspace_roles WHERE workspace_owner_id = $1 AND name = $2`,
        [row.workspace_owner_id, roleName],
      );
      roleId = found.rows[0].id;
    }
    await db.query(
      `UPDATE workspace_members
          SET custom_role_id = $1, role = 'member'
        WHERE workspace_owner_id = $2 AND role = $3`,
      [roleId, row.workspace_owner_id, row.role],
    );
    logger.info(
      `legacy-role-migration: seeded role "${roleName}" (id=${roleId}) for workspace ${row.workspace_owner_id}`,
    );
  }
  if (legacyRows.rows.length === 0) {
    logger.info("legacy-role-migration: no legacy designer/CSA rows to migrate");
  }

  // Profile fields on workspace_members — phone and job title.
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS phone text;`);
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS job_title text;`);
  logger.info("workspace_members profile columns ready");

  // Employment information fields on workspace_members.
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS start_date date;`);
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS department text;`);
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS location text;`);
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS employment_type text;`);
  await db.query(
    `ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS employment_status text NOT NULL DEFAULT 'active';`,
  );
  logger.info("workspace_members employment information columns ready");

  // Cover photos — per-brand seasonal/occasion images with a label.
  await db.query(`
    CREATE TABLE IF NOT EXISTS brand_cover_photos (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      brand_id            integer NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      label               text NOT NULL,
      photo_data          bytea NOT NULL,
      photo_mime          text NOT NULL,
      created_at          timestamptz DEFAULT now() NOT NULL
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'brand_cover_photos'
            AND indexname  = 'idx_cover_photos_brand'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_cover_photos_brand
         ON brand_cover_photos(workspace_owner_id, brand_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_cover_photos_brand: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_cover_photos_brand: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("brand_cover_photos table ready");

  // Location brands — brands assigned to Point of Sale locations.
  await db.query(`
    CREATE TABLE IF NOT EXISTS location_brands (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      location_id         integer NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      brand_id            integer NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      created_at          timestamptz DEFAULT now() NOT NULL,
      UNIQUE (location_id, brand_id)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'location_brands'
            AND indexname  = 'idx_location_brands_location'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_location_brands_location
         ON location_brands(workspace_owner_id, location_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_location_brands_location: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_location_brands_location: was missing — created successfully (deployment migrated)");
    }
  }
  // Actor email — who linked the brand to the location.
  await db.query(`
    ALTER TABLE location_brands ADD COLUMN IF NOT EXISTS actor_email text;
  `);
  logger.info("location_brands table ready");

  // Manager field — each member can optionally have another member as their manager.
  // ON DELETE SET NULL ensures removing a member automatically clears reports' manager field.
  await db.query(`
    ALTER TABLE workspace_members
      ADD COLUMN IF NOT EXISTS manager_member_id integer
        REFERENCES workspace_members(id) ON DELETE SET NULL;
  `);
  logger.info("workspace_members.manager_member_id column ready");

  // Per-user preference for receiving the "new time-off request" email when one
  // of their direct reports submits a time-off request. Defaults to true so
  // existing managers continue to receive emails as before.
  await db.query(`
    ALTER TABLE workspace_members
      ADD COLUMN IF NOT EXISTS notify_email_on_time_off_request boolean NOT NULL DEFAULT true;
  `);
  logger.info("workspace_members.notify_email_on_time_off_request column ready");

  // Per-user preference for receiving the "time-off decision" email when a
  // manager approves or denies their own time-off request. Defaults to true so
  // existing employees continue to receive emails as before.
  await db.query(`
    ALTER TABLE workspace_members
      ADD COLUMN IF NOT EXISTS notify_email_on_time_off_decision boolean NOT NULL DEFAULT true;
  `);
  logger.info("workspace_members.notify_email_on_time_off_decision column ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS failed_access_requests (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      requester_email     text NOT NULL,
      requester_name      text NOT NULL DEFAULT 'Unknown',
      error_message       text,
      created_at          timestamptz DEFAULT now() NOT NULL,
      dismissed_at        timestamptz
    );
  `);
  // Existing installations may have created this table before failed access
  // requests were tenant-scoped. Those rows cannot be safely attributed to a
  // workspace, so remove them before enforcing the new required tenant key.
  await db.query(
    `ALTER TABLE failed_access_requests
       ADD COLUMN IF NOT EXISTS workspace_owner_id text;`,
  );
  await db.query(
    `DELETE FROM failed_access_requests
      WHERE workspace_owner_id IS NULL;`,
  );
  await db.query(
    `ALTER TABLE failed_access_requests
       ALTER COLUMN workspace_owner_id SET NOT NULL;`,
  );
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'failed_access_requests'
            AND indexname  = 'idx_far_created'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_far_created
         ON failed_access_requests(created_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_far_created: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_far_created: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("failed_access_requests table ready");

  // Access requests — stores requests from Clerk-authenticated users who don't
  // yet have workspace access. Requests are scoped to their intended workspace.
  // NOTE: The initial CREATE TABLE omits the NOT NULL on requester_clerk_id so that
  // idempotent migrations can add the column to pre-existing rows without errors.
  // The column is made non-null only via a separate ALTER after back-filling.
  await db.query(`
    CREATE TABLE IF NOT EXISTS access_requests (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text,
      requester_clerk_id  text,
      requester_email     text NOT NULL,
      requester_name      text NOT NULL DEFAULT '',
      status              text NOT NULL DEFAULT 'pending',
      requested_at        timestamptz NOT NULL DEFAULT now(),
      resolved_at         timestamptz
    );
  `);
  // Idempotent column migrations — handle tables created by earlier schema versions.
  await db.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS workspace_owner_id text;`);
  await db.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS requester_clerk_id text;`);
  await db.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';`);
  await db.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS requested_at timestamptz NOT NULL DEFAULT now();`);
  await db.query(`ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS resolved_at timestamptz;`);
  // Back-fill legacy rows so the unique index can be applied.
  await db.query(
    `UPDATE access_requests
        SET requester_clerk_id = 'legacy_' || id::text
      WHERE requester_clerk_id IS NULL`,
  );
  // Legacy rows predate tenant targeting and cannot be safely attributed to a
  // workspace. Remove them rather than exposing them to an unrelated owner.
  await db.query(`DELETE FROM access_requests WHERE workspace_owner_id IS NULL;`);
  await db.query(
    `ALTER TABLE access_requests ALTER COLUMN workspace_owner_id SET NOT NULL;`,
  );
  await db.query(
    `ALTER TABLE access_requests ALTER COLUMN requester_clerk_id SET NOT NULL;`,
  );
  // Replace the legacy global uniqueness constraint with tenant-scoped uniqueness.
  {
    await db.query(`DROP INDEX IF EXISTS access_requests_clerk_id_unique;`);
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS access_requests_workspace_clerk_id_unique
         ON access_requests(workspace_owner_id, requester_clerk_id);`,
    );
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'access_requests'
            AND indexname  = 'idx_access_requests_workspace_status'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_access_requests_workspace_status
         ON access_requests(workspace_owner_id, status, requested_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_access_requests_workspace_status: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_access_requests_workspace_status: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("access_requests table ready");

  // Unique invite token — generated when a new invite is created, cleared once claimed.
  await db.query(`
    ALTER TABLE workspace_members
      ADD COLUMN IF NOT EXISTS invite_token text;
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'workspace_members'
            AND indexname  = 'idx_wm_invite_token'
       ) AS exists`,
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_invite_token
        ON workspace_members(invite_token)
        WHERE invite_token IS NOT NULL;`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_wm_invite_token: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_wm_invite_token: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("workspace_members.invite_token column ready");

  // Brand logos — per-brand logo images (replaces single logo_data/logo_mime columns on brands).
  await db.query(`
    CREATE TABLE IF NOT EXISTS brand_logos (
      id                  serial PRIMARY KEY,
      brand_id            integer NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      workspace_owner_id  text NOT NULL,
      label               text,
      logo_data           bytea NOT NULL,
      logo_mime           text NOT NULL,
      sort_order          integer NOT NULL DEFAULT 0,
      deleted_at          timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'brand_logos'
            AND indexname  = 'idx_brand_logos_brand'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_brand_logos_brand
         ON brand_logos(workspace_owner_id, brand_id)
         WHERE deleted_at IS NULL;`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_brand_logos_brand: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_brand_logos_brand: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("brand_logos table ready");

  // One-time migration: copy existing logo_data/logo_mime from brands into brand_logos as sort_order=0.
  const migratedLogos = await db.query(`
    INSERT INTO brand_logos (brand_id, workspace_owner_id, label, logo_data, logo_mime, sort_order)
    SELECT b.id, b.workspace_owner_id, NULL, b.logo_data, b.logo_mime, 0
      FROM brands b
     WHERE b.logo_data IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM brand_logos bl WHERE bl.brand_id = b.id
           )
    RETURNING id;
  `);
  if (migratedLogos.rowCount && migratedLogos.rowCount > 0) {
    logger.info(`brand_logos migration: moved ${migratedLogos.rowCount} logo(s) from brands to brand_logos`);
  } else {
    logger.info("brand_logos migration: no logos to migrate");
  }

  // Invite expiry — populated on invite creation; invite links stop working after this time.
  await db.query(`
    ALTER TABLE workspace_members
      ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz;
  `);
  logger.info("workspace_members.invite_expires_at column ready");

  // Products — workspace product catalogue with pricing, images, and brand association.
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      name                  text NOT NULL,
      price_usd             numeric(10,2) NOT NULL DEFAULT 0,
      price_aed             numeric(10,2) NOT NULL DEFAULT 0,
      main_image_url        text,
      additional_image_urls text[] NOT NULL DEFAULT '{}',
      image_public_path     text,
      additional_image_public_paths text[] NOT NULL DEFAULT '{}',
      image_display_public_path text,
      image_thumbnail_public_path text,
      additional_image_display_public_paths text[] NOT NULL DEFAULT '{}',
      additional_image_thumbnail_public_paths text[] NOT NULL DEFAULT '{}',
      description           text,
      status                text NOT NULL DEFAULT 'available',
      brand                 text,
      tags                  text[] NOT NULL DEFAULT '{}',
      created_at            timestamptz NOT NULL DEFAULT now()
    );
    DO $product_gallery_product_fk$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='product_gallery_runs_product_id_products_id_fk'
      ) THEN
        ALTER TABLE product_gallery_runs
          ADD CONSTRAINT product_gallery_runs_product_id_products_id_fk
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
      END IF;
    END
    $product_gallery_product_fk$;
  `);
  // The legacy free-text products.category column/index is RETAINED to keep the
  // development and production schemas aligned, so Replit's publish-time
  // migration stays clean and non-destructive. Production still holds this
  // column (with data) and its index; re-enabling these drops would delete that
  // data from production on the next deploy. Do NOT re-enable without a planned,
  // backed-up migration.
  // await db.query(`DROP INDEX IF EXISTS idx_products_category_trgm;`);
  // await db.query(`ALTER TABLE products DROP COLUMN IF EXISTS category;`);
  // image_public_path: stable key of the public, auth-free copy of the main
  // product image. additional_image_public_paths: public keys of the additional
  // image copies, positionally aligned with additional_image_urls. Both are
  // populated on create/update and by backfillProductPublicImages() at startup.
  // Optional sale/discount prices (nullable; null = not on sale).
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_price_usd numeric(10,2);`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_price_aed numeric(10,2);`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_public_path text;`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS additional_image_public_paths text[] NOT NULL DEFAULT '{}'::text[];`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_display_public_path text;`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_thumbnail_public_path text;`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS additional_image_display_public_paths text[] NOT NULL DEFAULT '{}'::text[];`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS additional_image_thumbnail_public_paths text[] NOT NULL DEFAULT '{}'::text[];`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS recipe_version integer NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS merchant_sync_disabled boolean NOT NULL DEFAULT false;`);

  // Merchant retirement approved by the business owner (Sep 2026). The exact
  // update is safely repeatable because already-disabled rows are excluded.
  // Only the Merchant exclusion flag is changed; every other product field
  // and every other table remain untouched.
  const discontinuedLebanonMerchantProducts = await db.query(`
    UPDATE products
       SET merchant_sync_disabled = TRUE
     WHERE workspace_owner_id = 'user_3DCcbYtdoRYrTOqHwKxb1gwXxJR'
       AND id = ANY (ARRAY[
         913, 465, 914, 1041, 1068, 1067, 443, 410, 407, 881,
         503, 879, 467, 1026, 441, 1036, 1040, 1042, 452, 1065,
         1039, 515, 1082, 493, 1038, 1066, 1027, 1069, 344, 521,
         563, 389, 446, 877, 1037, 401, 486
       ]::int[])
       AND merchant_sync_disabled IS NOT TRUE
     RETURNING id;
  `);
  logger.info(
    `merchant-retirement: disabled Merchant sync for ${discontinuedLebanonMerchantProducts.rowCount ?? 0} discontinued Lebanon product(s)`,
  );

  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'products'
            AND indexname  = 'idx_products_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_products_workspace
         ON products(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_products_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_products_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'products'
            AND indexname  = 'idx_products_brand'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_products_brand
         ON products(workspace_owner_id, brand);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_products_brand: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_products_brand: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'products'
            AND indexname  = 'idx_products_workspace_status'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_products_workspace_status
         ON products(workspace_owner_id, status);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info(
        "idx_products_workspace_status: already present in pg_indexes — no action needed",
      );
    } else {
      logger.info(
        "idx_products_workspace_status: was missing — created successfully (deployment migrated)",
      );
    }
  }
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sku text;`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode text;`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;`);
  // Per-product express-delivery eligibility. Default true so existing products
  // stay express-eligible. Independent of the city-level express setting: the
  // website shows express only when BOTH the product flag and the city setting
  // are on (this flag is an additional gate, never an override).
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS express_delivery_enabled boolean NOT NULL DEFAULT true;`);
  // Per-product "has input field" flag. Off by default. When on, the public
  // ordering website renders a free-text personalization input (max 22 chars)
  // whose value is stored per order line item in order_line_items.custom_input.
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS has_input_field boolean NOT NULL DEFAULT false;`);
  // Per-product "letter input" flag. Off by default. When on, the public
  // ordering website renders a single-letter (1 character) input for
  // letter-shaped products (e.g. "Pink Letter Box").
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS letter_input_enabled boolean NOT NULL DEFAULT false;`);
  // Per-product "upsell" flag. Off by default. When on, the product can appear
  // in an upsell category's section on the website (only when also linked to a
  // catalog category that is itself marked upsell).
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_upsell boolean NOT NULL DEFAULT false;`);
  // Cached auto-translated Arabic product description. Filled lazily
  // (best-effort) when florist orders are listed; null until translated.
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS description_ar text;`);
  // The WooCommerce product-matching column/index is RETAINED to keep dev and
  // production schemas aligned for a clean, non-destructive publish migration.
  // Production still holds this column and its index; re-enabling these drops
  // would alter the production schema on the next deploy. Do NOT re-enable
  // without a planned, backed-up migration.
  // await db.query(`DROP INDEX IF EXISTS idx_products_workspace_woo_product;`);
  // await db.query(`ALTER TABLE products DROP COLUMN IF EXISTS woo_product_id;`);
  // Ensure workspace-scoped SKU uniqueness is in place before the backfill runs.
  // The old global idx_products_sku index (if it still exists) is dropped first;
  // the per-workspace unique index is then created idempotently.
  await db.query(`DROP INDEX IF EXISTS idx_products_sku;`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_workspace_sku_unique
      ON products(workspace_owner_id, sku)
      WHERE sku IS NOT NULL;
  `);
  await db.query(`
    DO $$
    DECLARE
      r RECORD;
      candidate text;
    BEGIN
      FOR r IN SELECT id FROM products WHERE sku IS NULL LOOP
        LOOP
          candidate := lpad(floor(random() * 10000000)::int::text, 7, '0');
          BEGIN
            UPDATE products SET sku = candidate WHERE id = r.id;
            EXIT;
          EXCEPTION WHEN unique_violation THEN
          END;
        END LOOP;
      END LOOP;
    END
    $$;
  `);
  logger.info("products table ready");

  // Member locations — many-to-many junction: which members are assigned to which locations.
  // Members with no rows here see all data (no restriction).
  // Members with ≥1 row only see data belonging to their assigned locations.
  await db.query(`
    CREATE TABLE IF NOT EXISTS member_locations (
      id          serial PRIMARY KEY,
      member_id   integer NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      location_id integer NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (member_id, location_id)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'member_locations'
            AND indexname  = 'idx_member_locations_member'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_member_locations_member
         ON member_locations(member_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_member_locations_member: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_member_locations_member: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'member_locations'
            AND indexname  = 'idx_member_locations_location'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_member_locations_location
         ON member_locations(location_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_member_locations_location: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_member_locations_location: was missing — created successfully (deployment migrated)");
    }
  }
  // Actor email — who assigned the member to the location.
  await db.query(`
    ALTER TABLE member_locations ADD COLUMN IF NOT EXISTS actor_email text;
  `);
  logger.info("member_locations table ready");

  // Rent fields — annual rent amount, currency, and payment frequency per location.
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS annual_rent numeric;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS rent_currency text;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS payments_per_year integer;`);
  logger.info("locations rent columns ready");

  // Operations dashboard columns for locations (all nullable, safe defaults for existing rows).
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS daily_capacity integer;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS same_day_cutoff_time text;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS express_cutoff_time text;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS operating_hours jsonb;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS timezone text;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS backup_location_id integer REFERENCES locations(id) ON DELETE SET NULL;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS auto_routing_enabled boolean NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS paused_at timestamptz;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS paused_by text;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS pause_reason text;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS served_area_ids jsonb;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS internal_notes text;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS address text;`);
  logger.info("locations operations dashboard columns ready");

  // Available countries — list of countries enabled for this workspace.
  await db.query(`
    ALTER TABLE workspace_settings
      ADD COLUMN IF NOT EXISTS available_countries text[] NOT NULL DEFAULT ARRAY['Lebanon', 'United Arab Emirates'];
  `);
  logger.info("workspace_settings.available_countries column ready");

  // Payment links — shareable URLs for collecting payments via Stripe or PayPal.
  await db.query(`
    CREATE TABLE IF NOT EXISTS payment_links (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      amount              integer NOT NULL,
      currency            text NOT NULL DEFAULT 'USD',
      provider            text NOT NULL,
      description         text,
      status              text NOT NULL DEFAULT 'active',
      provider_link_id    text,
      provider_checkout_url text,
      public_token        text NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      paid_at             timestamptz
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'payment_links'
            AND indexname  = 'idx_payment_links_public_token'
       ) AS exists`,
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_links_public_token
         ON payment_links(public_token);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_payment_links_public_token: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_payment_links_public_token: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'payment_links'
            AND indexname  = 'idx_payment_links_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_payment_links_workspace
         ON payment_links(workspace_owner_id, created_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_payment_links_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_payment_links_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'payment_links'
            AND indexname  = 'idx_payment_links_provider_link_id'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_payment_links_provider_link_id
         ON payment_links(provider, provider_link_id)
         WHERE provider_link_id IS NOT NULL;`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_payment_links_provider_link_id: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_payment_links_provider_link_id: was missing — created successfully (deployment migrated)");
    }
  }
  await db.query(`
    ALTER TABLE payment_links
      ADD COLUMN IF NOT EXISTS created_by_member_id integer
        REFERENCES workspace_members(id) ON DELETE SET NULL;
  `);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS country text;`);
  logger.info("payment_links table ready");

  // -------------------------------------------------------------------------
  // coupons + supporting tables (discount/promo codes, USD only)
  // -------------------------------------------------------------------------
  await db.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text NOT NULL,
      code                text NOT NULL,
      description         text,
      discount_type       text NOT NULL DEFAULT 'percentage',
      discount_value      numeric(10,2) NOT NULL DEFAULT 0,
      min_order_usd       numeric(10,2),
      scope               text NOT NULL DEFAULT 'all',
      starts_at           timestamptz,
      expires_at          timestamptz,
      per_user_limit      integer,
      global_limit        integer,
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_workspace_code_unique
       ON coupons(workspace_owner_id, lower(code));`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_coupons_workspace
       ON coupons(workspace_owner_id);`,
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS coupon_products (
      coupon_id   uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
      product_id  integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      PRIMARY KEY (coupon_id, product_id)
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_coupon_products_product
       ON coupon_products(product_id);`,
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS coupon_attributes (
      coupon_id       uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
      attribute_type  text NOT NULL,
      attribute_id    integer NOT NULL,
      PRIMARY KEY (coupon_id, attribute_type, attribute_id)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS coupon_excluded_products (
      coupon_id   uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
      product_id  integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      PRIMARY KEY (coupon_id, product_id)
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_coupon_excluded_products_product
       ON coupon_excluded_products(product_id);`,
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS coupon_excluded_attributes (
      coupon_id       uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
      attribute_type  text NOT NULL,
      attribute_id    integer NOT NULL,
      PRIMARY KEY (coupon_id, attribute_type, attribute_id)
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_coupon_excluded_attributes_coupon
       ON coupon_excluded_attributes(coupon_id);`,
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      coupon_id           uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
      workspace_owner_id  text NOT NULL,
      order_id            uuid,
      customer_email      text,
      discount_amount_usd numeric(10,2) NOT NULL DEFAULT 0,
      status              text NOT NULL DEFAULT 'confirmed',
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_redemptions_order_unique
       ON coupon_redemptions(coupon_id, order_id)
       WHERE order_id IS NOT NULL;`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon
       ON coupon_redemptions(coupon_id);`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_email
       ON coupon_redemptions(coupon_id, customer_email);`,
  );
  logger.info("coupons tables ready");

  // B-tree index on (workspace_owner_id, sku) for fast workspace-scoped exact/prefix SKU lookups.
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'products'
            AND indexname  = 'idx_products_workspace_sku'
       ) AS exists`,
    );
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_products_workspace_sku
        ON products(workspace_owner_id, sku);
    `);
    if (existsBefore.rows[0].exists) {
      logger.info("idx_products_workspace_sku: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_products_workspace_sku: was missing — created successfully (deployment migrated)");
    }
  }

  // Product search GIN indexes — keep GET /api/products?q= fast as the catalogue grows.
  // These require the pg_trgm extension. Wrapped in try/catch so a missing or
  // restricted extension in the deployment environment does not prevent startup;
  // searches will fall back to sequential scans but remain functionally correct.
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    // One-time migration: if the existing GIN index was built on the functional
    // expression lower(name), drop it so we can replace it with a plain-column
    // index that ILIKE can use without evaluating a functional expression.
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_indexes
           WHERE indexname = 'idx_products_name_trgm'
             AND indexdef LIKE '%lower(name)%'
        ) THEN
          DROP INDEX idx_products_name_trgm;
        END IF;
      END $$;
    `);
    {
      const existsBefore = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename  = 'products'
              AND indexname  = 'idx_products_name_trgm'
         ) AS exists`,
      );
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_products_name_trgm
          ON products USING GIN (name gin_trgm_ops);
      `);
      if (existsBefore.rows[0].exists) {
        logger.info("idx_products_name_trgm: already present in pg_indexes — no action needed");
      } else {
        logger.info("idx_products_name_trgm: was missing — created successfully (deployment migrated)");
      }
    }
    {
      const existsBefore = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename  = 'products'
              AND indexname  = 'idx_products_brand_trgm'
         ) AS exists`,
      );
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_products_brand_trgm
          ON products USING GIN (lower(brand) gin_trgm_ops);
      `);
      if (existsBefore.rows[0].exists) {
        logger.info("idx_products_brand_trgm: already present in pg_indexes — no action needed");
      } else {
        logger.info("idx_products_brand_trgm: was missing — created successfully (deployment migrated)");
      }
    }
    {
      const existsBefore = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename  = 'products'
              AND indexname  = 'idx_products_sku_trgm'
         ) AS exists`,
      );
      // NOTE: this GIN is defined as a partial index (WHERE sku IS NOT NULL)
      // for the same reason as the unique btree idx_products_workspace_sku_unique:
      // we don't want to index rows where sku has no value.  However, because
      // BOTH indexes carry the identical partial predicate, the PostgreSQL query
      // planner knows they cover exactly the same row set and may treat the btree
      // as a cheaper substitute for a full index scan + ILIKE filter instead of
      // using the GIN bitmap scan the application intends.
      //
      // This planner competition is the root cause of the three GUC overrides
      // (enable_seqscan=OFF, enable_indexscan=OFF, random_page_cost=0.01) that
      // the SKU EXPLAIN integration test must apply to force selection of this
      // index.
      //
      // LONG-TERM FIX: remove the WHERE clause from this GIN so that it becomes
      // non-partial.  A non-partial GIN and a partial btree have different
      // predicates, so the planner can no longer treat them as equivalent; it will
      // prefer the GIN for trigram-pattern queries without needing hints.
      // Because initDb uses CREATE INDEX IF NOT EXISTS, the change requires an
      // explicit DROP INDEX idx_products_sku_trgm followed by the CREATE (or
      // REINDEX CONCURRENTLY on PG 14+) on any existing environment.
      // The index will be slightly larger (NULL sku rows take no space inside the
      // GIN posting lists, but the index header entry exists), which is acceptable
      // given the reliability improvement.
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_products_sku_trgm
          ON products USING GIN (sku gin_trgm_ops)
          WHERE sku IS NOT NULL;
      `);
      if (existsBefore.rows[0].exists) {
        logger.info("idx_products_sku_trgm: already present in pg_indexes — no action needed");
      } else {
        logger.info("idx_products_sku_trgm: was missing — created successfully (deployment migrated)");
      }
    }
    logger.info("products search indexes ready");
  } catch (err) {
    logger.warn(
      { err },
      "products search GIN indexes skipped — pg_trgm unavailable; searches will use sequential scans",
    );
  }

  // Channels — delivery/ordering channels with optional cover photo dimensions.
  await db.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      name                  text NOT NULL,
      has_cover_photo       boolean NOT NULL DEFAULT true,
      cover_photo_width     integer,
      cover_photo_height    integer,
      created_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'channels'
            AND indexname  = 'idx_channels_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_channels_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_channels_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'channels'
            AND indexname  = 'idx_channels_workspace_name_unique'
       ) AS exists`,
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_workspace_name_unique
         ON channels(workspace_owner_id, lower(name));`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_channels_workspace_name_unique: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_channels_workspace_name_unique: was missing — created successfully (deployment migrated)");
    }
  }
  // Add logo columns to channels if they don't exist yet.
  await db.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS logo_data bytea;`);
  await db.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS logo_mime_type text;`);
  logger.info("channels table ready");

  // channel_product_dimensions has been retired in favour of channel_image_configs.
  // Drop the old table if it still exists (data was migrated to channel_image_configs).
  await db.query(`DROP TABLE IF EXISTS channel_product_dimensions CASCADE;`);
  logger.info("channel_product_dimensions: retired (dropped if present)");

  // Base item categories — hierarchical (main → sub) classification system.
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_categories (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      parent_id           integer REFERENCES base_item_categories(id) ON DELETE CASCADE,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_item_categories'
            AND indexname  = 'idx_bic_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bic_workspace
         ON base_item_categories(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_bic_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_bic_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  // Extend base_item_categories with richer metadata columns.
  await db.query(`ALTER TABLE base_item_categories ADD COLUMN IF NOT EXISTS description text;`);
  await db.query(`ALTER TABLE base_item_categories ADD COLUMN IF NOT EXISTS category_type text;`);
  await db.query(`ALTER TABLE base_item_categories ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';`);
  await db.query(`ALTER TABLE base_item_categories ADD COLUMN IF NOT EXISTS updated_at timestamptz;`);
  await db.query(`ALTER TABLE base_item_categories ADD COLUMN IF NOT EXISTS created_by text;`);
  await db.query(`ALTER TABLE base_item_categories ADD COLUMN IF NOT EXISTS updated_by text;`);
  await db.query(`ALTER TABLE base_item_categories ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;`);
  logger.info("base_item_categories table ready");

  // Base items — ingredients/components used in product recipes.
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_items (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      code                text NOT NULL,
      image_url           text,
      category_id         integer REFERENCES base_item_categories(id) ON DELETE SET NULL,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  // image_public_path: stable key (relative to PUBLIC_OBJECT_SEARCH_PATHS) of
  // the public, auth-free copy of the base item image. Populated on
  // create/update and by the startup backfill in backfillBaseItemPublicImages().
  await db.query(`ALTER TABLE base_items ADD COLUMN IF NOT EXISTS image_public_path text;`);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_items'
            AND indexname  = 'idx_base_items_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_base_items_workspace
         ON base_items(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_base_items_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_base_items_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_items'
            AND indexname  = 'idx_base_items_workspace_code_unique'
       ) AS exists`,
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_base_items_workspace_code_unique
         ON base_items(workspace_owner_id, code);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_base_items_workspace_code_unique: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_base_items_workspace_code_unique: was missing — created successfully (deployment migrated)");
    }
  }
  await db.query(`
    ALTER TABLE base_items
      ADD COLUMN IF NOT EXISTS alternate_name    text,
      ADD COLUMN IF NOT EXISTS accounting_category text,
      ADD COLUMN IF NOT EXISTS tax_rate          numeric;
  `);
  await db.query(`
    ALTER TABLE base_items
      ADD COLUMN IF NOT EXISTS stock               numeric NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS low_stock_threshold numeric NOT NULL DEFAULT 0;
  `);
  logger.info("base_items optional columns ready");

  // Status, type, and merge/archive tracking columns (Task #983)
  await db.query(`
    ALTER TABLE base_items
      ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS type   text;
  `);
  await db.query(`
    ALTER TABLE base_items
      ADD COLUMN IF NOT EXISTS merged_into_base_item_id integer REFERENCES base_items(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS merged_at                 timestamptz,
      ADD COLUMN IF NOT EXISTS merged_by_user_id         text,
      ADD COLUMN IF NOT EXISTS archived_at               timestamptz,
      ADD COLUMN IF NOT EXISTS archived_by_user_id       text;
  `);
  logger.info("base_items status/merge/archive columns ready");

  // Audit log for bulk/destructive base item actions (Task #983)
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_audit_log (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      action             text NOT NULL,
      user_id            text NOT NULL,
      affected_ids       jsonb NOT NULL DEFAULT '[]',
      previous_values    jsonb,
      new_values         jsonb,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_item_audit_log'
            AND indexname  = 'idx_bial_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bial_workspace
         ON base_item_audit_log(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_bial_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_bial_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("base_item_audit_log table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_location_statuses (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      base_item_id        integer NOT NULL REFERENCES base_items(id) ON DELETE CASCADE,
      location_id         integer NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT base_item_location_statuses_unique UNIQUE (base_item_id, location_id)
    );
  `);
  await db.query(`
    ALTER TABLE base_item_location_statuses
      ADD COLUMN IF NOT EXISTS stock               numeric NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS low_stock_threshold numeric NOT NULL DEFAULT 0;
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_item_location_statuses'
            AND indexname  = 'idx_bils_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bils_workspace
         ON base_item_location_statuses(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_bils_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_bils_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("base_item_location_statuses table ready");

  logger.info("base_items table ready");

  // Role-channel access join table — which channels each custom role can see.
  await db.query(`
    CREATE TABLE IF NOT EXISTS role_channel_access (
      role_id    integer NOT NULL REFERENCES workspace_roles(id) ON DELETE CASCADE,
      channel_id integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, channel_id)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'role_channel_access'
            AND indexname  = 'idx_role_channel_access_channel'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_role_channel_access_channel ON role_channel_access(channel_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_role_channel_access_channel: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_role_channel_access_channel: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("role_channel_access table ready");

  // product_recipes — join table recording which base items (and how many) make up a product.
  await db.query(`
    CREATE TABLE IF NOT EXISTS product_recipes (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      product_id          integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      base_item_id        integer NOT NULL REFERENCES base_items(id) ON DELETE CASCADE,
      quantity            numeric NOT NULL DEFAULT 1,
      created_at          timestamptz DEFAULT now(),
      CONSTRAINT product_recipes_product_base_item_unique UNIQUE (product_id, base_item_id)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'product_recipes'
            AND indexname  = 'idx_product_recipes_product'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_product_recipes_product
         ON product_recipes(workspace_owner_id, product_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_product_recipes_product: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_product_recipes_product: was missing — created successfully (deployment migrated)");
    }
  }
  await db.query(
    `ALTER TABLE product_recipes ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;`,
  );
  logger.info("product_recipes table ready");

  // ── Recipe intelligence foundation ───────────────────────────────────────
  // These are proposal/audit records only. They intentionally never share a
  // table with product_recipes, which remains the sole live COGS/inventory
  // recipe source.
  // These parent keys must be table-level UNIQUE constraints. The publish
  // schema diff recognizes them as prerequisites for the dependent composite
  // foreign keys; ordinary CREATE INDEX statements can be emitted after those
  // foreign keys and therefore do not make a fresh migration safe.
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'recipe_intelligence_products_workspace_id_unique'
           AND conrelid = 'products'::regclass
      ) THEN
        IF EXISTS (
          SELECT 1
            FROM pg_index AS index_meta
            JOIN pg_class AS index_ref ON index_ref.oid = index_meta.indexrelid
           WHERE index_ref.relname = 'recipe_intelligence_products_workspace_id_unique_idx'
             AND index_meta.indrelid = 'products'::regclass
             AND index_meta.indisunique
             AND index_meta.indpred IS NULL
        ) THEN
          ALTER TABLE products
            ADD CONSTRAINT recipe_intelligence_products_workspace_id_unique
            UNIQUE USING INDEX recipe_intelligence_products_workspace_id_unique_idx;
        ELSE
          ALTER TABLE products
            ADD CONSTRAINT recipe_intelligence_products_workspace_id_unique
            UNIQUE (workspace_owner_id, id);
        END IF;
      END IF;
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'recipe_intelligence_base_items_workspace_id_unique'
           AND conrelid = 'base_items'::regclass
      ) THEN
        IF EXISTS (
          SELECT 1
            FROM pg_index AS index_meta
            JOIN pg_class AS index_ref ON index_ref.oid = index_meta.indexrelid
           WHERE index_ref.relname = 'recipe_intelligence_base_items_workspace_id_unique_idx'
             AND index_meta.indrelid = 'base_items'::regclass
             AND index_meta.indisunique
             AND index_meta.indpred IS NULL
        ) THEN
          ALTER TABLE base_items
            ADD CONSTRAINT recipe_intelligence_base_items_workspace_id_unique
            UNIQUE USING INDEX recipe_intelligence_base_items_workspace_id_unique_idx;
        ELSE
          ALTER TABLE base_items
            ADD CONSTRAINT recipe_intelligence_base_items_workspace_id_unique
            UNIQUE (workspace_owner_id, id);
        END IF;
      END IF;
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS recipe_suggestions (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      product_id         integer REFERENCES products(id) ON DELETE SET NULL,
      version            integer NOT NULL,
      version_manifest   jsonb NOT NULL DEFAULT '{}'::jsonb,
      status             text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'generated', 'under_review', 'approved', 'rejected', 'superseded')),
      generation_context jsonb NOT NULL DEFAULT '{}'::jsonb,
      confidence         numeric(5,4),
      rationale          text,
      created_by_user_id text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT recipe_suggestions_workspace_product_version_unique
        UNIQUE (workspace_owner_id, product_id, version),
      CONSTRAINT recipe_suggestions_workspace_id_unique
        UNIQUE (workspace_owner_id, id)
    );
  `);
  await db.query(`
    ALTER TABLE recipe_suggestions
      ADD COLUMN IF NOT EXISTS version_manifest jsonb NOT NULL DEFAULT '{}'::jsonb;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_recipe_suggestions_workspace_product
      ON recipe_suggestions(workspace_owner_id, product_id, created_at);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recipe_suggestion_lines (
      id                      serial PRIMARY KEY,
      workspace_owner_id      text NOT NULL,
      suggestion_id           integer NOT NULL REFERENCES recipe_suggestions(id) ON DELETE CASCADE,
      line_order              integer NOT NULL DEFAULT 0,
      proposed_base_item_id   integer REFERENCES base_items(id) ON DELETE SET NULL,
      proposed_base_item_name text,
      proposed_base_item_code text,
      extracted_requirement   text,
      unit_context            text,
      source_evidence         jsonb NOT NULL DEFAULT '[]'::jsonb,
      match_confidence        text NOT NULL DEFAULT 'no_match'
                              CHECK (match_confidence IN ('high', 'medium', 'low', 'no_match')),
      quantity                numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
      confidence              numeric(5,4),
      source_type             text NOT NULL,
      source_rule_id          integer,
      rationale               text,
      resolution_status       text NOT NULL DEFAULT 'unresolved'
                              CHECK (resolution_status IN ('resolved', 'unresolved', 'excluded')),
      exclusion_reason        text,
      exclusion_acknowledged  boolean NOT NULL DEFAULT false,
      created_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_recipe_suggestion_lines_suggestion
      ON recipe_suggestion_lines(workspace_owner_id, suggestion_id, line_order);
  `);
  // These fields were added after the initial audit-only foundation. Keeping
  // them as additive migrations preserves every historical draft while making
  // the selected item, requirement, unit, confidence, and supporting evidence
  // reviewable without reading opaque generation JSON.
  await db.query(`
    ALTER TABLE recipe_suggestion_lines
      ADD COLUMN IF NOT EXISTS proposed_base_item_code text,
      ADD COLUMN IF NOT EXISTS extracted_requirement text,
      ADD COLUMN IF NOT EXISTS unit_context text,
      ADD COLUMN IF NOT EXISTS source_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS match_confidence text NOT NULL DEFAULT 'no_match',
      ADD COLUMN IF NOT EXISTS resolution_status text NOT NULL DEFAULT 'unresolved',
      ADD COLUMN IF NOT EXISTS exclusion_reason text,
      ADD COLUMN IF NOT EXISTS exclusion_acknowledged boolean NOT NULL DEFAULT false;
  `);
  // Classify only rows that predate resolution_status. The marker prevents
  // later restarts from rewriting a reviewer's intentional unresolved choice.
  await db.query(`
    WITH claimed AS (
      INSERT INTO init_db_data_migrations (key)
      VALUES ('recipe-suggestion-line-resolution-status-v1')
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    )
    UPDATE recipe_suggestion_lines
       SET resolution_status = CASE
         WHEN proposed_base_item_id IS NOT NULL AND match_confidence <> 'no_match' THEN 'resolved'
         ELSE 'unresolved'
       END
     WHERE EXISTS (SELECT 1 FROM claimed);
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_suggestion_lines
        ADD CONSTRAINT recipe_suggestion_lines_match_confidence_check
        CHECK (match_confidence IN ('high', 'medium', 'low', 'no_match'));
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_suggestion_lines
        ADD CONSTRAINT recipe_suggestion_lines_resolution_status_check
        CHECK (resolution_status IN ('resolved', 'unresolved', 'excluded'));
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recipe_suggestion_actions (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      suggestion_id      integer NOT NULL REFERENCES recipe_suggestions(id) ON DELETE CASCADE,
      action             text NOT NULL
                         CHECK (action IN ('generated', 'submitted_for_review', 'corrected', 'approved', 'rejected', 'superseded', 'commented')),
      actor_user_id      text,
      note               text,
      context            jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_recipe_suggestion_actions_suggestion
      ON recipe_suggestion_actions(workspace_owner_id, suggestion_id, created_at);
  `);
  await db.query(`
    ALTER TABLE recipe_suggestion_actions DROP CONSTRAINT IF EXISTS recipe_suggestion_actions_action_check;
    ALTER TABLE recipe_suggestion_actions
      ADD CONSTRAINT recipe_suggestion_actions_action_check
      CHECK (action IN ('generated', 'submitted_for_review', 'corrected', 'approved', 'rejected', 'superseded', 'commented'));
  `);
  await db.query(`
    CREATE OR REPLACE FUNCTION prevent_recipe_suggestion_action_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'recipe_suggestion_actions is append-only';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS recipe_suggestion_actions_immutable ON recipe_suggestion_actions;
    CREATE TRIGGER recipe_suggestion_actions_immutable
      BEFORE UPDATE OR DELETE ON recipe_suggestion_actions
      FOR EACH ROW EXECUTE FUNCTION prevent_recipe_suggestion_action_mutation();
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recipe_suggestion_corrections (
      id                              serial PRIMARY KEY,
      workspace_owner_id              text NOT NULL,
      suggestion_id                   integer NOT NULL,
      line_id                         integer,
      correction_type                 text NOT NULL,
      extraction_error_type           text,
      original_structured_requirement jsonb NOT NULL DEFAULT '{}'::jsonb,
      corrected_structured_requirement jsonb NOT NULL DEFAULT '{}'::jsonb,
      original_line                   jsonb NOT NULL DEFAULT '{}'::jsonb,
      corrected_line                  jsonb NOT NULL DEFAULT '{}'::jsonb,
      product_context                 jsonb NOT NULL DEFAULT '{}'::jsonb,
      format_context                  jsonb NOT NULL DEFAULT '{}'::jsonb,
      reason                          text NOT NULL,
      note                            text,
      actor_user_id                   text,
      intent                          text NOT NULL DEFAULT 'product_only',
      proposed_scope                  text,
      candidate_alias_id              integer,
      candidate_rule_id               integer,
      candidate_metadata_id           integer,
      before_evidence                 jsonb NOT NULL DEFAULT '[]'::jsonb,
      after_evidence                  jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at                      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT recipe_suggestion_corrections_type_check
        CHECK (correction_type IN ('replace_base_item', 'change_quantity', 'add_line', 'remove_line', 'correct_requirement', 'preserve_unresolved')),
      CONSTRAINT recipe_suggestion_corrections_intent_check
        CHECK (intent IN ('product_only', 'propose_learning')),
      CONSTRAINT recipe_suggestion_corrections_workspace_suggestion_fk
        FOREIGN KEY (workspace_owner_id, suggestion_id)
        REFERENCES recipe_suggestions(workspace_owner_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_recipe_suggestion_corrections_suggestion
      ON recipe_suggestion_corrections(workspace_owner_id, suggestion_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_recipe_suggestion_corrections_type
      ON recipe_suggestion_corrections(workspace_owner_id, correction_type, created_at);

    CREATE OR REPLACE FUNCTION recipe_suggestion_corrections_immutable()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'recipe_suggestion_corrections is append-only';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_recipe_suggestion_corrections_immutable
      ON recipe_suggestion_corrections;
    CREATE TRIGGER trg_recipe_suggestion_corrections_immutable
      BEFORE UPDATE OR DELETE ON recipe_suggestion_corrections
      FOR EACH ROW EXECUTE FUNCTION recipe_suggestion_corrections_immutable();
  `);

  // ── Bloomprint ─────────────────────────────────────────────────────────────
  // These records retain only temporary creative work. A final Bloomprint is a
  // normal products + product_recipes record, never a parallel catalog model.
  await db.query(`
    CREATE TABLE IF NOT EXISTS bloomprint_style_profiles (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      name                  text NOT NULL,
      version               integer NOT NULL DEFAULT 1,
      prompt                text NOT NULL,
      reference_image_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_default            boolean NOT NULL DEFAULT false,
      created_by_user_id    text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT bloomprint_style_profiles_workspace_name_version_unique
        UNIQUE (workspace_owner_id, name, version)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bloomprint_style_profiles_workspace
      ON bloomprint_style_profiles(workspace_owner_id, created_at);
  `);
  await db.query(`
    UPDATE bloomprint_style_profiles
       SET prompt = 'Presentail catalogue house style: create a premium, photorealistic studio product photograph for a modern Gulf floral gifting brand. The finished arrangement is the sole hero, centered and fully visible, photographed at a refined three-quarter angle in a clean editorial composition. Use realistic fresh botanicals with natural petal texture, subtle tonal variation, believable stems, careful proportion, and an intentional florist-built silhouette. Present it in a premium Presentail gift box in the selected box colour, with a discreet, correctly spelled Presentail wordmark printed directly on the box. Use a warm soft-ivory to very pale stone seamless background, natural diffused daylight from upper left, soft grounded shadow, accurate colour, gentle depth of field, and luxury ecommerce retouching. Keep the result elegant, calm, contemporary, and catalogue-ready. Do not add graphic overlays, extra copy, price tags, stickers, watermarks, floating text, people, hands, tools, or unrelated products.'
     WHERE name = 'Presentail floral catalogue'
       AND prompt = 'Create a polished, premium floral catalogue photograph. Keep the arrangement centered, naturally lit, botanically believable, with no text, logos, hands, price tags, or watermarks.';
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS bloomprint_drafts (
      id                          serial PRIMARY KEY,
      workspace_owner_id          text NOT NULL,
      inspiration_image_path      text NOT NULL,
      analysis                    jsonb NOT NULL DEFAULT '{}'::jsonb,
      name                        text,
      description                 text,
      price_usd                   numeric(10,2),
      price_aed                   numeric(10,2),
      box_color                   text NOT NULL DEFAULT 'black',
      substitution_notes          text,
      status                      text NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft', 'analysis_failed', 'rendered', 'render_failed', 'approved', 'discarded')),
      style_profile_id            integer REFERENCES bloomprint_style_profiles(id) ON DELETE SET NULL,
      recipe_suggestion_id        integer REFERENCES recipe_suggestions(id) ON DELETE SET NULL,
      generated_image_path        text,
      generated_image_public_path text,
      approved_product_id         integer REFERENCES products(id) ON DELETE SET NULL,
      created_by_user_id          text,
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bloomprint_drafts_workspace_status
      ON bloomprint_drafts(workspace_owner_id, status, created_at DESC);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS bloomprint_render_attempts (
      id                serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      draft_id          integer NOT NULL REFERENCES bloomprint_drafts(id) ON DELETE CASCADE,
      status            text NOT NULL DEFAULT 'started'
                        CHECK (status IN ('started', 'succeeded', 'failed')),
      model             text NOT NULL DEFAULT 'gpt-image-1',
      generation_mode   text NOT NULL DEFAULT 'text_only',
      reference_image_count integer NOT NULL DEFAULT 0,
      prompt            text NOT NULL,
      output_image_path text,
      error_message     text,
      created_at        timestamptz NOT NULL DEFAULT now(),
      completed_at      timestamptz
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bloomprint_render_attempts_draft
      ON bloomprint_render_attempts(workspace_owner_id, draft_id, created_at DESC);
  `);
  await db.query(`
    ALTER TABLE bloomprint_style_profiles
      ADD COLUMN IF NOT EXISTS reference_image_paths jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE bloomprint_drafts
      ADD COLUMN IF NOT EXISTS box_color text NOT NULL DEFAULT 'black';
    ALTER TABLE bloomprint_render_attempts
      ADD COLUMN IF NOT EXISTS generation_mode text NOT NULL DEFAULT 'text_only';
    ALTER TABLE bloomprint_render_attempts
      ADD COLUMN IF NOT EXISTS reference_image_count integer NOT NULL DEFAULT 0;
  `);
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bloomprint_drafts_status_check') THEN
        ALTER TABLE bloomprint_drafts ADD CONSTRAINT bloomprint_drafts_status_check
          CHECK (status IN ('draft', 'analysis_failed', 'rendered', 'render_failed', 'approved', 'discarded'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bloomprint_drafts_approved_product_id_fkey') THEN
        ALTER TABLE bloomprint_drafts ADD CONSTRAINT bloomprint_drafts_approved_product_id_fkey
          FOREIGN KEY (approved_product_id) REFERENCES products(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bloomprint_render_attempts_status_check') THEN
        ALTER TABLE bloomprint_render_attempts ADD CONSTRAINT bloomprint_render_attempts_status_check
          CHECK (status IN ('started', 'succeeded', 'failed'));
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recipe_rules (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      rule_key            text NOT NULL,
      name                text NOT NULL,
      description         text,
      rule_type           text NOT NULL DEFAULT 'hidden_item',
      source              text NOT NULL DEFAULT 'discovered'
                          CHECK (source IN ('deterministic', 'discovered', 'manual')),
      status              text NOT NULL DEFAULT 'candidate'
                          CHECK (status IN ('candidate', 'approved', 'rejected', 'inactive')),
      definition          jsonb NOT NULL DEFAULT '{}'::jsonb,
      confidence          numeric(5,4),
      created_by_user_id  text,
      decided_by_user_id  text,
      decided_at          timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT recipe_rules_workspace_key_unique UNIQUE (workspace_owner_id, rule_key)
      , CONSTRAINT recipe_rules_workspace_id_unique UNIQUE (workspace_owner_id, id)
    );
  `);
  await db.query(`
    ALTER TABLE recipe_rules DROP CONSTRAINT IF EXISTS recipe_rules_status_check;
    ALTER TABLE recipe_rules
      ADD CONSTRAINT recipe_rules_status_check
      CHECK (status IN ('candidate', 'approved', 'rejected', 'inactive'));
  `);
  // These two rules are confirmed operating requirements, not discovered
  // candidates. Existing workspaces created during the audit-only rollout may
  // still hold their seed rows as candidates, so promote only these known keys.
  await db.query(`
    UPDATE recipe_rules
       SET status = 'approved', updated_at = now()
     WHERE source = 'deterministic'
       AND rule_key IN ('flower-box-sponge', 'balloon-metal-ring')
       AND status = 'candidate';
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_recipe_rules_workspace_status
      ON recipe_rules(workspace_owner_id, status, created_at);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS recipe_rule_evidence (
      id                         serial PRIMARY KEY,
      workspace_owner_id         text NOT NULL,
      rule_id                    integer NOT NULL REFERENCES recipe_rules(id) ON DELETE CASCADE,
      evidence_type              text NOT NULL
                                 CHECK (evidence_type IN ('supporting', 'conflicting', 'observation')),
      product_id                 integer REFERENCES products(id) ON DELETE SET NULL,
      base_item_id               integer REFERENCES base_items(id) ON DELETE SET NULL,
      product_name_snapshot      text,
      base_item_name_snapshot    text,
      details                    jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at                 timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_recipe_rule_evidence_rule
      ON recipe_rule_evidence(workspace_owner_id, rule_id, created_at);
  `);
  await db.query(`
    CREATE OR REPLACE FUNCTION prevent_recipe_rule_evidence_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'recipe_rule_evidence is append-only';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS recipe_rule_evidence_immutable ON recipe_rule_evidence;
    CREATE TRIGGER recipe_rule_evidence_immutable
      BEFORE UPDATE OR DELETE ON recipe_rule_evidence
      FOR EACH ROW EXECUTE FUNCTION prevent_recipe_rule_evidence_mutation();
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recipe_rule_actions (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      rule_id            integer NOT NULL REFERENCES recipe_rules(id) ON DELETE CASCADE,
      action             text NOT NULL CHECK (action IN ('seeded', 'discovered', 'approved', 'rejected', 'edited', 'deactivated', 'rolled_back')),
      actor_user_id      text,
      previous_state     jsonb NOT NULL DEFAULT '{}'::jsonb,
      next_state         jsonb NOT NULL DEFAULT '{}'::jsonb,
      note               text,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_recipe_rule_actions_rule
      ON recipe_rule_actions(workspace_owner_id, rule_id, created_at);
  `);
  await db.query(`
    ALTER TABLE recipe_rule_actions DROP CONSTRAINT IF EXISTS recipe_rule_actions_action_check;
    ALTER TABLE recipe_rule_actions
      ADD CONSTRAINT recipe_rule_actions_action_check
      CHECK (action IN ('seeded', 'discovered', 'approved', 'rejected', 'edited', 'deactivated', 'rolled_back'));
  `);
  await db.query(`
    CREATE OR REPLACE FUNCTION prevent_recipe_rule_action_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Recipe rule actions are append-only';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS recipe_rule_actions_immutable ON recipe_rule_actions;
    CREATE TRIGGER recipe_rule_actions_immutable
      BEFORE UPDATE OR DELETE ON recipe_rule_actions
      FOR EACH ROW EXECUTE FUNCTION prevent_recipe_rule_action_mutation();
  `);
  // Governed Base Item intelligence is kept separate from operational
  // base_items: extraction may propose data, but it cannot silently change it.
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_metadata_candidates (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      base_item_id          integer NOT NULL,
      attribute_type        text NOT NULL,
      proposed_value        jsonb NOT NULL,
      source_text           text,
      extraction_method     text NOT NULL,
      confidence            numeric(5,4),
      source_type           text NOT NULL DEFAULT 'system'
                            CHECK (source_type IN ('actor', 'system')),
      source_actor_user_id  text,
      status                text NOT NULL DEFAULT 'candidate'
                            CHECK (status IN ('candidate', 'approved', 'rejected', 'deactivated')),
      decided_by_user_id    text,
      decided_at            timestamptz,
      decision_note         text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT base_item_metadata_candidates_workspace_id_unique
        UNIQUE (workspace_owner_id, id),
      CONSTRAINT base_item_metadata_candidates_workspace_base_item_fk
        FOREIGN KEY (workspace_owner_id, base_item_id)
        REFERENCES base_items(workspace_owner_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bimc_workspace_status
      ON base_item_metadata_candidates(workspace_owner_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_bimc_base_item
      ON base_item_metadata_candidates(workspace_owner_id, base_item_id, created_at);

    CREATE TABLE IF NOT EXISTS base_item_metadata_candidate_decisions (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      candidate_id          integer NOT NULL,
      action                text NOT NULL
                            CHECK (action IN ('created', 'corrected', 'approved', 'rejected', 'deactivated', 'commented')),
      actor_user_id         text,
      previous_state        jsonb NOT NULL DEFAULT '{}'::jsonb,
      next_state            jsonb NOT NULL DEFAULT '{}'::jsonb,
      note                  text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT base_item_metadata_candidate_decisions_workspace_candidate_fk
        FOREIGN KEY (workspace_owner_id, candidate_id)
        REFERENCES base_item_metadata_candidates(workspace_owner_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bimcd_candidate
      ON base_item_metadata_candidate_decisions(workspace_owner_id, candidate_id, created_at);

    CREATE TABLE IF NOT EXISTS base_item_aliases (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      base_item_id          integer NOT NULL,
      alias                 text NOT NULL,
      normalized_alias      text NOT NULL,
      source_type           text NOT NULL DEFAULT 'actor'
                            CHECK (source_type IN ('actor', 'system')),
      source_actor_user_id  text,
      status                text NOT NULL DEFAULT 'candidate'
                            CHECK (status IN ('candidate', 'approved', 'rejected', 'deactivated')),
      decided_by_user_id    text,
      decided_at            timestamptz,
      decision_note         text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT base_item_aliases_workspace_id_unique
        UNIQUE (workspace_owner_id, id),
      CONSTRAINT base_item_aliases_workspace_normalized_alias_unique
        UNIQUE (workspace_owner_id, normalized_alias),
      CONSTRAINT base_item_aliases_workspace_base_item_fk
        FOREIGN KEY (workspace_owner_id, base_item_id)
        REFERENCES base_items(workspace_owner_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bia_workspace_base_item
      ON base_item_aliases(workspace_owner_id, base_item_id, status);
    ALTER TABLE base_item_aliases
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

    CREATE TABLE IF NOT EXISTS base_item_alias_decisions (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      alias_id              integer NOT NULL,
      action                text NOT NULL
                            CHECK (action IN ('created', 'corrected', 'approved', 'rejected', 'deactivated', 'commented')),
      actor_user_id         text,
      previous_state        jsonb NOT NULL DEFAULT '{}'::jsonb,
      next_state            jsonb NOT NULL DEFAULT '{}'::jsonb,
      note                  text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT base_item_alias_decisions_workspace_alias_fk
        FOREIGN KEY (workspace_owner_id, alias_id)
        REFERENCES base_item_aliases(workspace_owner_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_biad_alias
      ON base_item_alias_decisions(workspace_owner_id, alias_id, created_at);
  `);
  // #4889 originally created these ledgers without the correction action.
  // Rebuild the named CHECK constraints on every startup so existing databases
  // accept the same append-only history as newly-created ones.
  await db.query(`
    ALTER TABLE base_item_metadata_candidate_decisions
      DROP CONSTRAINT IF EXISTS base_item_metadata_candidate_decisions_action_check;
    ALTER TABLE base_item_metadata_candidate_decisions
      ADD CONSTRAINT base_item_metadata_candidate_decisions_action_check
      CHECK (action IN ('created', 'corrected', 'approved', 'rejected', 'deactivated', 'commented'));
    ALTER TABLE base_item_alias_decisions
      DROP CONSTRAINT IF EXISTS base_item_alias_decisions_action_check;
    ALTER TABLE base_item_alias_decisions
      ADD CONSTRAINT base_item_alias_decisions_action_check
      CHECK (action IN ('created', 'corrected', 'approved', 'rejected', 'deactivated', 'commented'));
  `);
  // Decisions are an audit ledger, not mutable state. The candidate itself
  // holds its current lifecycle state and every transition is recorded here.
  await db.query(`
    CREATE OR REPLACE FUNCTION prevent_base_item_governance_decision_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Base Item governance decisions are append-only';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS base_item_metadata_candidate_decisions_immutable
      ON base_item_metadata_candidate_decisions;
    CREATE TRIGGER base_item_metadata_candidate_decisions_immutable
      BEFORE UPDATE OR DELETE ON base_item_metadata_candidate_decisions
      FOR EACH ROW EXECUTE FUNCTION prevent_base_item_governance_decision_mutation();
    DROP TRIGGER IF EXISTS base_item_alias_decisions_immutable
      ON base_item_alias_decisions;
    CREATE TRIGGER base_item_alias_decisions_immutable
      BEFORE UPDATE OR DELETE ON base_item_alias_decisions
      FOR EACH ROW EXECUTE FUNCTION prevent_base_item_governance_decision_mutation();
  `);
  // IDs are globally serial, but all intelligence records are scoped. These
  // composite FKs prevent cross-workspace parent/product/base-item links even
  // when a caller somehow knows an ID from another workspace.
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_suggestion_lines
        ADD CONSTRAINT recipe_suggestion_lines_source_rule_fk
        FOREIGN KEY (source_rule_id) REFERENCES recipe_rules(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_suggestions
        ADD CONSTRAINT recipe_suggestions_workspace_product_fk
        FOREIGN KEY (workspace_owner_id, product_id)
        REFERENCES products(workspace_owner_id, id)
        ON DELETE SET NULL (product_id);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_suggestion_lines
        ADD CONSTRAINT recipe_suggestion_lines_workspace_suggestion_fk
        FOREIGN KEY (workspace_owner_id, suggestion_id)
        REFERENCES recipe_suggestions(workspace_owner_id, id)
        ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_suggestion_lines
        ADD CONSTRAINT recipe_suggestion_lines_workspace_base_item_fk
        FOREIGN KEY (workspace_owner_id, proposed_base_item_id)
        REFERENCES base_items(workspace_owner_id, id)
        ON DELETE SET NULL (proposed_base_item_id);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_suggestion_actions
        ADD CONSTRAINT recipe_suggestion_actions_workspace_suggestion_fk
        FOREIGN KEY (workspace_owner_id, suggestion_id)
        REFERENCES recipe_suggestions(workspace_owner_id, id)
        ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_rule_evidence
        ADD CONSTRAINT recipe_rule_evidence_workspace_rule_fk
        FOREIGN KEY (workspace_owner_id, rule_id)
        REFERENCES recipe_rules(workspace_owner_id, id)
        ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_rule_evidence
        ADD CONSTRAINT recipe_rule_evidence_workspace_product_fk
        FOREIGN KEY (workspace_owner_id, product_id)
        REFERENCES products(workspace_owner_id, id)
        ON DELETE SET NULL (product_id);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_rule_evidence
        ADD CONSTRAINT recipe_rule_evidence_workspace_base_item_fk
        FOREIGN KEY (workspace_owner_id, base_item_id)
        REFERENCES base_items(workspace_owner_id, id)
        ON DELETE SET NULL (base_item_id);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_rule_actions
        ADD CONSTRAINT recipe_rule_actions_workspace_rule_fk
        FOREIGN KEY (workspace_owner_id, rule_id)
        REFERENCES recipe_rules(workspace_owner_id, id)
        ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE recipe_suggestion_lines
        ADD CONSTRAINT recipe_suggestion_lines_workspace_source_rule_fk
        FOREIGN KEY (workspace_owner_id, source_rule_id)
        REFERENCES recipe_rules(workspace_owner_id, id)
        ON DELETE SET NULL (source_rule_id);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
  `);

  // These two deterministic rules are confirmed operating requirements and must
  // always be active. Seed them as 'approved' so they apply on first use.
  // The DO UPDATE promotes any workspace that received an earlier 'candidate'
  // seed from a prior deployment, without touching user-managed rules.
  await db.query(`
    INSERT INTO recipe_rules (
      workspace_owner_id, rule_key, name, description, rule_type, source,
      status, definition, confidence
    )
    SELECT w.workspace_owner_id,
           seed.rule_key,
           seed.name,
           seed.description,
           'hidden_item',
           'deterministic',
           'approved',
           seed.definition::jsonb,
           0.9900
      FROM (SELECT DISTINCT workspace_owner_id FROM workspace_members WHERE role = 'owner') w
      CROSS JOIN (
        VALUES
          (
            'flower-box-sponge',
            'Flower-box products need sponge',
            'Suggest a sponge when a flower-box product has a flower-box component.',
            '{"product_keywords":["flower","box"],"required_base_item_keywords":["sponge"]}'
          ),
          (
            'balloon-metal-ring',
            'Balloon products need a metal ring',
            'Suggest a metal ring when a balloon product needs structural support.',
            '{"product_keywords":["balloon"],"required_base_item_keywords":["metal ring","ring"]}'
          )
      ) AS seed(rule_key, name, description, definition)
    ON CONFLICT (workspace_owner_id, rule_key)
      DO UPDATE SET status = 'approved'
        WHERE recipe_rules.source = 'deterministic'
          AND recipe_rules.status = 'candidate';
  `);
  await db.query(`
    INSERT INTO recipe_rule_actions (
      workspace_owner_id, rule_id, action, previous_state, next_state
    )
    SELECT rr.workspace_owner_id,
           rr.id,
           'seeded',
           '{}'::jsonb,
           jsonb_build_object(
             'rule_key', rr.rule_key,
             'status', rr.status,
             'source', rr.source,
             'definition', rr.definition
           )
      FROM recipe_rules rr
     WHERE rr.source = 'deterministic'
       AND NOT EXISTS (
         SELECT 1
           FROM recipe_rule_actions action
          WHERE action.rule_id = rr.id
            AND action.workspace_owner_id = rr.workspace_owner_id
            AND action.action = 'seeded'
       );
  `);
  logger.info("recipe intelligence tables and deterministic approved rules ready");

  // Recipe accuracy benchmarks are append-only snapshots. They intentionally
  // never write to product_recipes, so an owner can review benchmark output
  // without changing live COGS or inventory inputs.
  await db.query(`
    CREATE TABLE IF NOT EXISTS recipe_benchmark_runs (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      created_by_user_id  text NOT NULL,
      created_by_email    text,
      status              text NOT NULL,
      engine_version      text NOT NULL,
      version_manifest    jsonb NOT NULL DEFAULT '{}'::jsonb,
      sample_definition   jsonb NOT NULL,
      sample_composition  jsonb NOT NULL,
      exclusions          jsonb NOT NULL,
      metrics             jsonb NOT NULL,
      limitations         jsonb NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      completed_at        timestamptz
    );
  `);
  // Additive because benchmark snapshots are immutable once recorded. Existing
  // rows receive an empty manifest; new writers snapshot all dependency
  // revisions (engine/rules/aliases/metadata/prompt/model) in this JSON value.
  await db.query(`
    ALTER TABLE recipe_benchmark_runs
      ADD COLUMN IF NOT EXISTS version_manifest jsonb NOT NULL DEFAULT '{}'::jsonb;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_recipe_benchmark_runs_workspace
      ON recipe_benchmark_runs(workspace_owner_id, created_at DESC);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS recipe_benchmark_results (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      run_id                integer NOT NULL REFERENCES recipe_benchmark_runs(id),
      product_id            integer NOT NULL,
      product_snapshot      jsonb NOT NULL,
      approved_recipe       jsonb NOT NULL,
      generated_suggestion  jsonb NOT NULL,
      evidence_used         jsonb NOT NULL,
      comparison            jsonb NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT recipe_benchmark_results_run_product_unique UNIQUE (run_id, product_id)
    );
  `);
  await db.query(`
    DO $$
    DECLARE legacy_fk record;
    BEGIN
      FOR legacy_fk IN
        SELECT constraint_name
          FROM information_schema.key_column_usage
         WHERE table_schema = 'public'
           AND table_name = 'recipe_benchmark_results'
           AND column_name = 'product_id'
           AND constraint_name <> 'recipe_benchmark_results_run_product_unique'
      LOOP
        EXECUTE format(
          'ALTER TABLE recipe_benchmark_results DROP CONSTRAINT IF EXISTS %I',
          legacy_fk.constraint_name
        );
      END LOOP;
    END $$;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_recipe_benchmark_results_workspace
      ON recipe_benchmark_results(workspace_owner_id, created_at DESC);
  `);
  await db.query(`
    CREATE OR REPLACE FUNCTION prevent_recipe_benchmark_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Recipe benchmark records are immutable';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.query(`
    DROP TRIGGER IF EXISTS recipe_benchmark_runs_immutable ON recipe_benchmark_runs;
    CREATE TRIGGER recipe_benchmark_runs_immutable
      BEFORE UPDATE OR DELETE ON recipe_benchmark_runs
      FOR EACH ROW EXECUTE FUNCTION prevent_recipe_benchmark_mutation();
    DROP TRIGGER IF EXISTS recipe_benchmark_results_immutable ON recipe_benchmark_results;
    CREATE TRIGGER recipe_benchmark_results_immutable
      BEFORE UPDATE OR DELETE ON recipe_benchmark_results
      FOR EACH ROW EXECUTE FUNCTION prevent_recipe_benchmark_mutation();
  `);
  logger.info("recipe benchmark tables ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS notification_seen_ids (
      user_id           text NOT NULL,
      access_request_id integer NOT NULL,
      seen_at           timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, access_request_id)
    );
  `);
  logger.info("notification_seen_ids table ready");

  // One-time cleanup: remove orphaned notification_seen_ids rows that
  // reference access requests which are no longer pending (approved, rejected,
  // or deleted). This runs BEFORE the FK constraint is added so that stale
  // rows (pointing to non-existent or resolved access_requests) don't cause
  // the ALTER TABLE below to fail.
  const seenCleanupResult = await db.query(`
    DELETE FROM notification_seen_ids
    WHERE access_request_id NOT IN (
      SELECT id FROM access_requests WHERE status = 'pending'
    );
  `);
  if (seenCleanupResult.rowCount && seenCleanupResult.rowCount > 0) {
    logger.info(
      `notification_seen_ids cleanup: removed ${seenCleanupResult.rowCount} orphaned row(s)`,
    );
  } else {
    logger.info("notification_seen_ids cleanup: no orphaned rows found");
  }

  // Add FK from notification_seen_ids.access_request_id → access_requests(id) ON DELETE CASCADE.
  // Uses a DO block so this migration is idempotent. It intentionally also
  // handles the case where the constraint already exists but was created WITHOUT
  // ON DELETE CASCADE (confdeltype 'a' = NO ACTION; 'c' = CASCADE): in that
  // situation the old constraint is dropped first and the correct one is added.
  // This prevents orphaned notification_seen_ids rows when access_requests rows
  // are bulk-deleted, expired, or removed by means other than the
  // approve/reject handlers.
  await db.query(`
    DO $$
    DECLARE
      fkey_exists     boolean;
      has_cascade     boolean;
    BEGIN
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname    = 'notification_seen_ids_access_request_id_fkey'
           AND conrelid   = 'notification_seen_ids'::regclass
      ) INTO fkey_exists;

      IF fkey_exists THEN
        SELECT (confdeltype = 'c') INTO has_cascade
          FROM pg_constraint
         WHERE conname    = 'notification_seen_ids_access_request_id_fkey'
           AND conrelid   = 'notification_seen_ids'::regclass;

        IF NOT has_cascade THEN
          -- Existing constraint lacks ON DELETE CASCADE — drop and recreate.
          ALTER TABLE notification_seen_ids
            DROP CONSTRAINT notification_seen_ids_access_request_id_fkey;
          fkey_exists := false;
        END IF;
      END IF;

      IF NOT fkey_exists THEN
        ALTER TABLE notification_seen_ids
          ADD CONSTRAINT notification_seen_ids_access_request_id_fkey
          FOREIGN KEY (access_request_id)
          REFERENCES access_requests(id)
          ON DELETE CASCADE;
      END IF;
    END $$;
  `);
  logger.info("notification_seen_ids FK (ON DELETE CASCADE) constraint ready");


  // product_location_statuses — per-product per-location availability toggles.
  await db.query(`
    CREATE TABLE IF NOT EXISTS product_location_statuses (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      product_id          integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      location_id         integer NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT product_location_statuses_unique UNIQUE (product_id, location_id)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'product_location_statuses'
            AND indexname  = 'idx_pls_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_pls_workspace
         ON product_location_statuses(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_pls_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_pls_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("product_location_statuses table ready");

  // Time Off Module — Phase 1: database schema & seed data.

  // Drop legacy employment_start_date on workspace_members — superseded by start_date.
  // Backfill any non-null legacy values into start_date before dropping the column.
  // Guarded so a fresh DB (where the legacy column never existed) does not error.
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'workspace_members'
           AND column_name = 'employment_start_date'
      ) THEN
        EXECUTE '
          UPDATE workspace_members
             SET start_date = employment_start_date
           WHERE start_date IS NULL
             AND employment_start_date IS NOT NULL
        ';
      END IF;
    END
    $$;
  `);
  await db.query(`
    ALTER TABLE workspace_members
      DROP COLUMN IF EXISTS employment_start_date;
  `);
  logger.info("workspace_members.employment_start_date column dropped (superseded by start_date)");

  // time_off_types — defines the kinds of leave a workspace supports.
  await db.query(`
    CREATE TABLE IF NOT EXISTS time_off_types (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      code                text NOT NULL,
      name                text NOT NULL,
      is_paid             boolean NOT NULL DEFAULT true,
      requires_approval   boolean NOT NULL DEFAULT true,
      color               text NOT NULL DEFAULT '#6b7280',
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT time_off_types_workspace_code_unique UNIQUE (workspace_owner_id, code)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'time_off_types'
            AND indexname  = 'idx_time_off_types_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_time_off_types_workspace
         ON time_off_types(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_time_off_types_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_time_off_types_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("time_off_types table ready");

  // time_off_policies — configurable leave policies per workspace.
  await db.query(`
    CREATE TABLE IF NOT EXISTS time_off_policies (
      id                              serial PRIMARY KEY,
      workspace_owner_id              text NOT NULL,
      name                            text NOT NULL,
      description                     text,
      vacation_days_per_year          numeric(5,1) NOT NULL DEFAULT 15,
      sick_leave_days_per_year        numeric(5,1),
      accrual_type                    text NOT NULL DEFAULT 'ANNUAL_GRANT',
      annual_grant_month              integer NOT NULL DEFAULT 1,
      carryover_allowed               boolean NOT NULL DEFAULT false,
      max_carryover_days              numeric(5,1),
      applies_after_months_of_employment integer NOT NULL DEFAULT 0,
      is_active                       boolean NOT NULL DEFAULT true,
      created_at                      timestamptz NOT NULL DEFAULT now(),
      updated_at                      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT time_off_policies_workspace_name_unique UNIQUE (workspace_owner_id, name)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'time_off_policies'
            AND indexname  = 'idx_time_off_policies_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_time_off_policies_workspace
         ON time_off_policies(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_time_off_policies_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_time_off_policies_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("time_off_policies table ready");

  // user_time_off_policies — tracks which policy is assigned to each member (with history).
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_time_off_policies (
      id                    serial PRIMARY KEY,
      member_id             integer NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      policy_id             integer NOT NULL REFERENCES time_off_policies(id) ON DELETE CASCADE,
      effective_from        date NOT NULL,
      effective_to          date,
      assigned_by_member_id integer REFERENCES workspace_members(id) ON DELETE SET NULL,
      created_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'user_time_off_policies'
            AND indexname  = 'idx_utp_member'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_utp_member
         ON user_time_off_policies(member_id, effective_from DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_utp_member: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_utp_member: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("user_time_off_policies table ready");

  // time_off_balances — per member per policy year balance tracking.
  await db.query(`
    CREATE TABLE IF NOT EXISTS time_off_balances (
      id                          serial PRIMARY KEY,
      member_id                   integer NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      policy_id                   integer NOT NULL REFERENCES time_off_policies(id) ON DELETE CASCADE,
      policy_year                 integer NOT NULL,
      vacation_entitled           numeric(6,2) NOT NULL DEFAULT 0,
      vacation_used               numeric(6,2) NOT NULL DEFAULT 0,
      vacation_pending            numeric(6,2) NOT NULL DEFAULT 0,
      vacation_carryover          numeric(6,2) NOT NULL DEFAULT 0,
      sick_leave_entitled         numeric(6,2),
      sick_leave_used             numeric(6,2) NOT NULL DEFAULT 0,
      sick_leave_pending          numeric(6,2) NOT NULL DEFAULT 0,
      manually_adjusted_by_member_id integer REFERENCES workspace_members(id) ON DELETE SET NULL,
      adjustment_reason           text,
      updated_at                  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT time_off_balances_member_year_unique UNIQUE (member_id, policy_year)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'time_off_balances'
            AND indexname  = 'idx_tob_member_year'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tob_member_year
         ON time_off_balances(member_id, policy_year DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_tob_member_year: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_tob_member_year: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("time_off_balances table ready");

  // time_off_balance_adjustments — immutable audit log of every manual balance change.
  await db.query(`
    CREATE TABLE IF NOT EXISTS time_off_balance_adjustments (
      id                          serial PRIMARY KEY,
      member_id                   integer NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      policy_id                   integer NOT NULL REFERENCES time_off_policies(id) ON DELETE CASCADE,
      policy_year                 integer NOT NULL,
      vacation_entitled_before    numeric(6,2) NOT NULL,
      vacation_entitled_after     numeric(6,2) NOT NULL,
      reason                      text NOT NULL,
      adjusted_by_member_id       integer REFERENCES workspace_members(id) ON DELETE SET NULL,
      created_at                  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_toba_member
      ON time_off_balance_adjustments(member_id, created_at DESC);
  `);
  logger.info("time_off_balance_adjustments table ready");

  // time_off_requests — individual leave requests submitted by members.
  await db.query(`
    CREATE TABLE IF NOT EXISTS time_off_requests (
      id                      serial PRIMARY KEY,
      workspace_owner_id      text NOT NULL,
      member_id               integer NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      manager_member_id       integer REFERENCES workspace_members(id) ON DELETE SET NULL,
      type_id                 integer NOT NULL REFERENCES time_off_types(id) ON DELETE RESTRICT,
      start_date              date NOT NULL,
      end_date                date NOT NULL,
      total_days              numeric(6,2) NOT NULL,
      half_day                boolean NOT NULL DEFAULT false,
      half_day_period         text,
      reason                  text,
      status                  text NOT NULL DEFAULT 'PENDING',
      manager_note            text,
      reviewed_by_member_id   integer REFERENCES workspace_members(id) ON DELETE SET NULL,
      reviewed_at             timestamptz,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now(),
      deleted_at              timestamptz
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'time_off_requests'
            AND indexname  = 'idx_tor_workspace_member'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tor_workspace_member
         ON time_off_requests(workspace_owner_id, member_id, start_date DESC)
         WHERE deleted_at IS NULL;`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_tor_workspace_member: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_tor_workspace_member: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'time_off_requests'
            AND indexname  = 'idx_tor_status'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_tor_status
         ON time_off_requests(workspace_owner_id, status, start_date DESC)
         WHERE deleted_at IS NULL;`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_tor_status: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_tor_status: was missing — created successfully (deployment migrated)");
    }
  }
  // Cancellation tracking columns — nullable, added in the "cancel approved future requests" update.
  await db.query(`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;`);
  await db.query(`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS cancelled_by text;`);
  await db.query(`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS cancellation_reason text;`);
  logger.info("time_off_requests table ready");

  // time_off_notifications — notifications sent to a manager when an employee submits a request.
  await db.query(`
    CREATE TABLE IF NOT EXISTS time_off_notifications (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      recipient_member_id   integer NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      actor_member_id       integer NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      type                  text NOT NULL DEFAULT 'TIME_OFF_REQUEST',
      title                 text NOT NULL,
      body                  text NOT NULL,
      entity_type           text NOT NULL DEFAULT 'time_off_request',
      entity_id             integer REFERENCES time_off_requests(id) ON DELETE CASCADE,
      is_read               boolean NOT NULL DEFAULT false,
      created_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_ton_recipient
       ON time_off_notifications(recipient_member_id, created_at DESC)
       WHERE NOT is_read;`,
  );
  logger.info("time_off_notifications table ready");

  // Seed time_off_types with workspace-owner-scoped rows for every workspace owner.
  // Uses a DO block so seeding is idempotent and workspace-aware.
  await db.query(`
    DO $$
    DECLARE
      owner_id text;
    BEGIN
      FOR owner_id IN
        SELECT DISTINCT workspace_owner_id FROM workspace_members WHERE workspace_owner_id = member_user_id
      LOOP
        INSERT INTO time_off_types (workspace_owner_id, code, name, is_paid, requires_approval, color)
        VALUES
          (owner_id, 'VACATION',   'Vacation',   true, true, '#10b981'),
          (owner_id, 'SICK_LEAVE', 'Sick Leave',  true, true, '#f59e0b')
        ON CONFLICT (workspace_owner_id, code) DO NOTHING;
      END LOOP;
    END $$;
  `);
  logger.info("time_off_types seed ready");

  // Seed time_off_policies with the standard policy for every workspace owner.
  await db.query(`
    DO $$
    DECLARE
      owner_id text;
    BEGIN
      FOR owner_id IN
        SELECT DISTINCT workspace_owner_id FROM workspace_members WHERE workspace_owner_id = member_user_id
      LOOP
        INSERT INTO time_off_policies (
          workspace_owner_id,
          name,
          description,
          vacation_days_per_year,
          sick_leave_days_per_year,
          accrual_type,
          annual_grant_month,
          carryover_allowed,
          max_carryover_days,
          applies_after_months_of_employment,
          is_active
        )
        VALUES (
          owner_id,
          'Presentail Standard Policy',
          'Default policy granting 15 vacation days per year with optional carry-over of up to 10 days.',
          15,
          NULL,
          'ANNUAL_GRANT',
          1,
          true,
          10,
          12,
          true
        )
        ON CONFLICT (workspace_owner_id, name) DO UPDATE
          SET
            vacation_days_per_year = EXCLUDED.vacation_days_per_year,
            is_active               = EXCLUDED.is_active,
            max_carryover_days      = EXCLUDED.max_carryover_days
          WHERE time_off_policies.vacation_days_per_year = 0;
      END LOOP;
    END $$;
  `);
  logger.info("time_off_policies seed ready");

  // Suppliers — workspace-level supplier directory.
  await db.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      contact_name        text,
      contact_email       text,
      contact_phone       text,
      is_archived         boolean NOT NULL DEFAULT false,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'suppliers'
            AND indexname  = 'idx_suppliers_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_suppliers_workspace
         ON suppliers(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_suppliers_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_suppliers_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS country text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tax_number text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS odoo_partner_id integer`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS suppliers_workspace_odoo_partner_unique
    ON suppliers(workspace_owner_id, odoo_partner_id)
    WHERE odoo_partner_id IS NOT NULL`);
  // Reset the sequence to avoid duplicate-key errors when rows were inserted
  // outside of the sequence (e.g. via direct SQL or a previous migration bug).
  await db.query(
    `SELECT setval('suppliers_id_seq', COALESCE((SELECT MAX(id) FROM suppliers), 0) + 1, false)`,
  );
  logger.info("suppliers table ready");

  // Shared canonical UOM foundation. Codes are stable identities; display names
  // and context availability can evolve independently.
  await db.query(`
    CREATE TABLE IF NOT EXISTS uom_catalog (
      code          text PRIMARY KEY,
      display_name  text NOT NULL,
      is_active     boolean NOT NULL DEFAULT true,
      sort_order    integer NOT NULL DEFAULT 0,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_uom_catalog_active_sort
      ON uom_catalog(is_active, sort_order);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS uom_aliases (
      id                serial PRIMARY KEY,
      uom_code          text NOT NULL REFERENCES uom_catalog(code) ON DELETE CASCADE,
      alias             text NOT NULL,
      normalized_alias  text NOT NULL,
      is_active         boolean NOT NULL DEFAULT true,
      created_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_uom_aliases_normalized_unique
      ON uom_aliases(normalized_alias);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_uom_aliases_code
      ON uom_aliases(uom_code);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS uom_context_availability (
      id          serial PRIMARY KEY,
      uom_code    text NOT NULL REFERENCES uom_catalog(code) ON DELETE CASCADE,
      context     text NOT NULL,
      is_active   boolean NOT NULL DEFAULT true,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_uom_context_code_unique
      ON uom_context_availability(context, uom_code);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_uom_context_active
      ON uom_context_availability(context, is_active);
  `);
  await db.query(`
    INSERT INTO uom_catalog (code, display_name, sort_order)
    VALUES
      ('piece', 'Piece', 10),
      ('stem', 'Stem', 20),
      ('bunch', 'Bunch', 30),
      ('pack', 'Pack', 40),
      ('box', 'Box', 50),
      ('kg', 'Kg', 60),
      ('g', 'Gram', 70),
      ('liter', 'Liter', 80),
      ('ml', 'Milliliter', 90),
      ('meter', 'Meter', 100),
      ('cm', 'Centimeter', 110),
      ('set', 'Set', 120),
      ('pair', 'Pair', 130),
      ('dozen', 'Dozen', 140)
    ON CONFLICT (code) DO NOTHING;
  `);
  await db.query(`
    INSERT INTO uom_aliases (uom_code, alias, normalized_alias)
    VALUES
      ('piece', 'piece', 'piece'),
      ('piece', 'pieces', 'pieces'),
      ('piece', 'pc', 'pc'),
      ('piece', 'pcs', 'pcs'),
      ('stem', 'stem', 'stem'),
      ('stem', 'stems', 'stems'),
      ('bunch', 'bunch', 'bunch'),
      ('bunch', 'bunches', 'bunches'),
      ('pack', 'pack', 'pack'),
      ('pack', 'packs', 'packs'),
      ('box', 'box', 'box'),
      ('box', 'boxes', 'boxes'),
      ('kg', 'kg', 'kg'),
      ('kg', 'kilogram', 'kilogram'),
      ('kg', 'kilograms', 'kilograms'),
      ('g', 'g', 'g'),
      ('g', 'gram', 'gram'),
      ('g', 'grams', 'grams'),
      ('liter', 'liter', 'liter'),
      ('liter', 'liters', 'liters'),
      ('liter', 'litre', 'litre'),
      ('liter', 'litres', 'litres'),
      ('ml', 'ml', 'ml'),
      ('ml', 'milliliter', 'milliliter'),
      ('ml', 'milliliters', 'milliliters'),
      ('ml', 'millilitre', 'millilitre'),
      ('ml', 'millilitres', 'millilitres'),
      ('meter', 'meter', 'meter'),
      ('meter', 'meters', 'meters'),
      ('meter', 'metre', 'metre'),
      ('meter', 'metres', 'metres'),
      ('cm', 'cm', 'cm'),
      ('cm', 'centimeter', 'centimeter'),
      ('cm', 'centimeters', 'centimeters'),
      ('cm', 'centimetre', 'centimetre'),
      ('cm', 'centimetres', 'centimetres'),
      ('set', 'set', 'set'),
      ('set', 'sets', 'sets'),
      ('pair', 'pair', 'pair'),
      ('pair', 'pairs', 'pairs'),
      ('dozen', 'dozen', 'dozen'),
      ('dozen', 'dozens', 'dozens')
    ON CONFLICT (normalized_alias) DO NOTHING;
  `);
  await db.query(`
    INSERT INTO uom_context_availability (uom_code, context)
    SELECT code, 'supplier_pricing'
      FROM uom_catalog
     WHERE code = ANY(ARRAY[
       'piece', 'stem', 'bunch', 'pack', 'box', 'kg', 'g',
       'liter', 'ml', 'meter', 'cm', 'set', 'pair', 'dozen'
     ])
    ON CONFLICT (context, uom_code) DO NOTHING;
  `);
  logger.info("canonical UOM catalog, aliases, and supplier-pricing context ready");

  // Base item packages — packaging definitions for a base item.
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_packages (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      base_item_id        integer NOT NULL REFERENCES base_items(id) ON DELETE CASCADE,
      name                text NOT NULL,
      unit                text,
      quantity            integer NOT NULL DEFAULT 1,
      barcode             text,
      is_default          boolean NOT NULL DEFAULT false,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_item_packages'
            AND indexname  = 'idx_bip_base_item'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bip_base_item
         ON base_item_packages(base_item_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_bip_base_item: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_bip_base_item: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("base_item_packages table ready");

  // Migration: auto-insert the default "1 Piece" package for existing base items
  // that don't yet have a default package row.
  const missingDefaultPkgs = await db.query<{ id: number; name: string; workspace_owner_id: string }>(
    `SELECT bi.id, bi.name, bi.workspace_owner_id
       FROM base_items bi
      WHERE NOT EXISTS (
        SELECT 1 FROM base_item_packages bip
         WHERE bip.base_item_id = bi.id AND bip.is_default = true
      )`,
  );
  for (const bi of missingDefaultPkgs.rows) {
    await db.query(
      `INSERT INTO base_item_packages (workspace_owner_id, base_item_id, name, quantity, is_default)
       VALUES ($1, $2, $3, 1, true)`,
      [bi.workspace_owner_id, bi.id, `${bi.name} 1 Piece`],
    );
  }
  if (missingDefaultPkgs.rows.length > 0) {
    logger.info(`base-item-packages-migration: inserted default package for ${missingDefaultPkgs.rows.length} base item(s)`);
  } else {
    logger.info("base-item-packages-migration: all base items already have a default package");
  }

  // Base item suppliers — links between base items and workspace suppliers.
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_suppliers (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      base_item_id        integer NOT NULL REFERENCES base_items(id) ON DELETE CASCADE,
      supplier_id         integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      package_id          integer REFERENCES base_item_packages(id) ON DELETE SET NULL,
      supplier_item_name  text,
      supplier_item_code  text,
      pricing_uom_code    text REFERENCES uom_catalog(code) ON DELETE RESTRICT,
      pricing_uom         text,
      price               numeric(14,4),
      currency            text NOT NULL DEFAULT 'AED' CHECK (currency IN ('AED', 'USD')),
      is_preferred        boolean NOT NULL DEFAULT false,
      is_default_order_unit boolean NOT NULL DEFAULT false,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_item_suppliers'
            AND indexname  = 'idx_bis_base_item'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bis_base_item
         ON base_item_suppliers(base_item_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_bis_base_item: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_bis_base_item: was missing — created successfully (deployment migrated)");
    }
  }
  // Dedup existing base_item_suppliers rows before adding the unique index.
  // Without this step, CREATE UNIQUE INDEX fails on any workspace that already
  // has duplicate (workspace_owner_id, base_item_id, supplier_id) rows.
  // Strategy: keep the highest id per group (most recently created); remap any
  // purchase_order_line_items references so FK integrity is maintained.
  {
    const poliCheck = await db.query(`SELECT to_regclass('purchase_order_line_items') AS t`);
    if (poliCheck.rows[0]?.t) {
      // Only remap if base_item_supplier_id column already exists on the table.
      // On a first deploy after the merged task, the column is added later in
      // initDb (line ~2601); running this UPDATE before that ADD COLUMN causes
      // "column poli.base_item_supplier_id does not exist". If the column is
      // absent there is no data to remap anyway.
      const colCheck = await db.query(`
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'purchase_order_line_items'
           AND column_name = 'base_item_supplier_id'
         LIMIT 1
      `);
      if (colCheck.rows[0]) {
        // Remap PO line items from a duplicate BIS id to the kept (max) id for that group.
        await db.query(`
          UPDATE purchase_order_line_items poli
             SET base_item_supplier_id = kept.keep_id
            FROM (
              SELECT
                UNNEST(ARRAY_REMOVE(ARRAY_AGG(id ORDER BY id), MAX(id))) AS drop_id,
                MAX(id) AS keep_id
              FROM base_item_suppliers
              GROUP BY workspace_owner_id, base_item_id, supplier_id
              HAVING COUNT(*) > 1
            ) kept
           WHERE poli.base_item_supplier_id = kept.drop_id;
        `);
      }
    }
    // Delete the lower-id duplicates — keeps exactly one row per group.
    await db.query(`
      DELETE FROM base_item_suppliers
       WHERE id NOT IN (
         SELECT MAX(id)
           FROM base_item_suppliers
          GROUP BY workspace_owner_id, base_item_id, supplier_id
       );
    `);
    logger.info("base_item_suppliers deduplication: complete (idempotent)");
  }
  // Unique constraint so bulk-add supplier can use ON CONFLICT DO NOTHING
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bis_base_item_supplier_unique
      ON base_item_suppliers(workspace_owner_id, base_item_id, supplier_id);
  `);
  logger.info("base_item_suppliers table ready");

  // Step 1: name_ar / name_ar_source on base_item_suppliers
  await db.query(`ALTER TABLE base_item_suppliers ADD COLUMN IF NOT EXISTS pricing_uom_code text;`);
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'base_item_suppliers_pricing_uom_code_fkey'
           AND conrelid = 'base_item_suppliers'::regclass
      ) THEN
        ALTER TABLE base_item_suppliers
          ADD CONSTRAINT base_item_suppliers_pricing_uom_code_fkey
          FOREIGN KEY (pricing_uom_code) REFERENCES uom_catalog(code) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  await db.query(`ALTER TABLE base_item_suppliers ADD COLUMN IF NOT EXISTS name_ar text;`);
  await db.query(`ALTER TABLE base_item_suppliers ADD COLUMN IF NOT EXISTS name_ar_source text;`);
  logger.info("base_item_suppliers.name_ar columns ready");

  // Step 2 & 3: Only run if supplier_catalog_items exists (it is created later in initDb;
  // on a brand-new DB these blocks are no-ops and will be re-run on the next startup).
  const sciExists = await db.query(
    `SELECT to_regclass('supplier_catalog_items') AS t`,
  );
  if (sciExists.rows[0]?.t) {
    // Step 2: Populate name_ar from supplier_catalog_items where the catalog item is
    // linked to the same base_item_id + supplier_id and the BIS row has no name_ar yet.
    await db.query(`
      UPDATE base_item_suppliers bis
         SET name_ar = sci.name_ar,
             name_ar_source = 'migrated'
        FROM supplier_catalog_items sci
       WHERE sci.base_item_id  = bis.base_item_id
         AND sci.supplier_id   = bis.supplier_id
         AND sci.workspace_owner_id = bis.workspace_owner_id
         AND sci.name_ar IS NOT NULL
         AND bis.name_ar IS NULL;
    `);
    logger.info("base_item_suppliers name_ar migration: propagated from supplier_catalog_items");

    // Step 3: Bootstrap missing base_item_suppliers rows from linked supplier_catalog_items
    // (idempotent — skips any pair that already has a BIS row)
    await db.query(`
      INSERT INTO base_item_suppliers
        (workspace_owner_id, base_item_id, supplier_id,
         supplier_item_name, supplier_item_code, price, currency, pricing_uom,
         name_ar, name_ar_source)
      SELECT
        sci.workspace_owner_id,
        sci.base_item_id,
        sci.supplier_id,
        sci.name,
        sci.supplier_item_code,
        sci.price,
        sci.currency,
        sci.unit,
        sci.name_ar,
        CASE WHEN sci.name_ar IS NOT NULL THEN 'migrated' ELSE NULL END
      FROM supplier_catalog_items sci
      WHERE sci.base_item_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM base_item_suppliers bis
           WHERE bis.workspace_owner_id = sci.workspace_owner_id
             AND bis.base_item_id = sci.base_item_id
             AND bis.supplier_id  = sci.supplier_id
        )
      ON CONFLICT DO NOTHING;
    `);
    logger.info("base_item_suppliers bootstrap migration: inserted missing rows from supplier_catalog_items");
  } else {
    logger.info("base_item_suppliers name_ar / bootstrap migrations: skipped (supplier_catalog_items not yet created)");
  }

  // Capture a workspace-attributed, value-level audit before mutation so the
  // migration report explains which legacy values were mapped versus retained.
  const uomBackfillAudit = await db.query<{
    workspace_owner_id: string;
    normalized_legacy_value: string;
    row_count: string;
    mapped_code: string | null;
  }>(`
    WITH legacy_values AS (
      SELECT workspace_owner_id,
             regexp_replace(lower(btrim(pricing_uom)), '[[:space:]]+', ' ', 'g') AS normalized_legacy_value,
             COUNT(*)::text AS row_count
        FROM base_item_suppliers
       WHERE pricing_uom_code IS NULL
         AND NULLIF(btrim(pricing_uom), '') IS NOT NULL
       GROUP BY workspace_owner_id,
                regexp_replace(lower(btrim(pricing_uom)), '[[:space:]]+', ' ', 'g')
    )
    SELECT lv.workspace_owner_id,
           lv.normalized_legacy_value,
           lv.row_count,
           CASE
             WHEN COUNT(DISTINCT CASE WHEN uca.id IS NOT NULL THEN uc.code END) = 1
             THEN MIN(CASE WHEN uca.id IS NOT NULL THEN uc.code END)
             ELSE NULL
           END AS mapped_code
      FROM legacy_values lv
      LEFT JOIN uom_aliases ua
        ON ua.normalized_alias = lv.normalized_legacy_value
       AND ua.is_active = true
      LEFT JOIN uom_catalog uc
        ON uc.code = ua.uom_code
       AND uc.is_active = true
      LEFT JOIN uom_context_availability uca
        ON uca.uom_code = uc.code
       AND uca.context = 'supplier_pricing'
       AND uca.is_active = true
     GROUP BY lv.workspace_owner_id, lv.normalized_legacy_value, lv.row_count
     ORDER BY lv.workspace_owner_id, lv.normalized_legacy_value;
  `);

  // Resolve only active, supplier-pricing aliases that map unambiguously.
  // Unknown text remains untouched in pricing_uom for explicit review.
  const uomBackfill = await db.query<{ id: number; workspace_owner_id: string }>(`
    UPDATE base_item_suppliers bis
       SET pricing_uom_code = resolved.uom_code
      FROM (
        SELECT bis2.id, MIN(ua.uom_code) AS uom_code
          FROM base_item_suppliers bis2
          JOIN uom_aliases ua
            ON ua.normalized_alias = regexp_replace(lower(btrim(bis2.pricing_uom)), '[[:space:]]+', ' ', 'g')
           AND ua.is_active = true
          JOIN uom_catalog uc
            ON uc.code = ua.uom_code
           AND uc.is_active = true
          JOIN uom_context_availability uca
            ON uca.uom_code = uc.code
           AND uca.context = 'supplier_pricing'
           AND uca.is_active = true
         WHERE bis2.pricing_uom_code IS NULL
           AND NULLIF(btrim(bis2.pricing_uom), '') IS NOT NULL
         GROUP BY bis2.id
        HAVING COUNT(DISTINCT ua.uom_code) = 1
      ) resolved
     WHERE bis.id = resolved.id
       AND bis.pricing_uom_code IS NULL
    RETURNING bis.id, bis.workspace_owner_id;
  `);
  const uomUnmapped = await db.query<{ workspace_owner_id: string; count: string }>(`
    SELECT workspace_owner_id, COUNT(*)::text AS count
      FROM base_item_suppliers
     WHERE pricing_uom_code IS NULL
       AND NULLIF(btrim(pricing_uom), '') IS NOT NULL
     GROUP BY workspace_owner_id
     ORDER BY workspace_owner_id;
  `);
  const mappedByWorkspace = uomBackfill.rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.workspace_owner_id] = (acc[row.workspace_owner_id] ?? 0) + 1;
    return acc;
  }, {});
  const unmappedByWorkspace = Object.fromEntries(
    uomUnmapped.rows.map((row) => [row.workspace_owner_id, Number(row.count)]),
  );
  const auditOutcomes = uomBackfillAudit.rows.map((row) => ({
    workspaceOwnerId: row.workspace_owner_id,
    legacyValue: row.normalized_legacy_value,
    rowCount: Number(row.row_count),
    mappedCode: row.mapped_code,
  }));
  logger.info(
    {
      mapped: uomBackfill.rows.length,
      unmapped: uomUnmapped.rows.reduce((sum, row) => sum + Number(row.count), 0),
      mappedByWorkspace,
      unmappedByWorkspace,
      distinctLegacyValues: auditOutcomes.length,
      outcomes: auditOutcomes.slice(0, 100),
      outcomesTruncated: auditOutcomes.length > 100,
    },
    "supplier-pricing UOM backfill complete",
  );

  // base_item_supplier_id on purchase_order_line_items — tracks which BIS row sourced a line
  // Guard: purchase_order_line_items is created later in initDb; skip on a brand-new DB.
  const poliExists = await db.query(`SELECT to_regclass('purchase_order_line_items') AS t`);
  if (poliExists.rows[0]?.t) {
    await db.query(`
      ALTER TABLE purchase_order_line_items
        ADD COLUMN IF NOT EXISTS base_item_supplier_id integer REFERENCES base_item_suppliers(id) ON DELETE SET NULL;
    `);
    // Snapshot the package conversion factor so receiving is unaffected by
    // later BIS / package edits or link removals.
    await db.query(`
      ALTER TABLE purchase_order_line_items
        ADD COLUMN IF NOT EXISTS package_quantity numeric;
    `);
    logger.info("purchase_order_line_items.base_item_supplier_id / package_quantity columns ready");
  } else {
    logger.info("purchase_order_line_items.base_item_supplier_id / package_quantity: skipped (table not yet created)");
  }

  // #44 — cancelled job state: track which status a job was in when cancelled
  await db.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS pre_cancel_status text;`);
  logger.info("print_jobs.pre_cancel_status column ready");

  // #56 — adjustable undo duration (seconds); default 5 s to match existing behaviour.
  await db.query(`
    ALTER TABLE workspace_settings
      ADD COLUMN IF NOT EXISTS undo_duration_seconds integer NOT NULL DEFAULT 5;
  `);
  logger.info("workspace_settings.undo_duration_seconds column ready");

  // Per-marketplace-channel commission rates (percent) for Marketplace Analytics.
  // Keyed by canonical channel key; code supplies defaults for missing keys.
  await db.query(`
    ALTER TABLE workspace_settings
      ADD COLUMN IF NOT EXISTS marketplace_commission_rates jsonb NOT NULL DEFAULT '{}'::jsonb;
  `);
  logger.info("workspace_settings.marketplace_commission_rates column ready");

  // #41 — role change audit log
  await db.query(`
    CREATE TABLE IF NOT EXISTS role_change_audit_log (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      changed_by_user_id text NOT NULL,
      target_member_id   integer NOT NULL,
      old_role           text,
      new_role           text,
      old_custom_role_id integer,
      new_custom_role_id integer,
      changed_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'role_change_audit_log'
            AND indexname  = 'idx_rcal_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_rcal_workspace
         ON role_change_audit_log(workspace_owner_id, changed_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_rcal_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_rcal_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("role_change_audit_log table ready");

  // Time Off Module — Phase 3: public holiday tables.

  // public_holiday_calendars — named holiday calendars per workspace.
  await db.query(`
    CREATE TABLE IF NOT EXISTS public_holiday_calendars (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      country_code        text,
      location_id         integer REFERENCES locations(id) ON DELETE SET NULL,
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'public_holiday_calendars'
            AND indexname  = 'idx_phc_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_phc_workspace
         ON public_holiday_calendars(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_phc_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_phc_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("public_holiday_calendars table ready");

  // public_holidays — individual holiday entries within a calendar.
  await db.query(`
    CREATE TABLE IF NOT EXISTS public_holidays (
      id                      serial PRIMARY KEY,
      calendar_id             integer NOT NULL REFERENCES public_holiday_calendars(id) ON DELETE CASCADE,
      workspace_owner_id      text NOT NULL,
      name                    text NOT NULL,
      date                    date NOT NULL,
      end_date                date,
      is_paid                 boolean NOT NULL DEFAULT true,
      description             text,
      created_by_member_id    integer REFERENCES workspace_members(id) ON DELETE SET NULL,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'public_holidays'
            AND indexname  = 'idx_ph_calendar'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_ph_calendar
         ON public_holidays(calendar_id, date ASC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_ph_calendar: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_ph_calendar: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("public_holidays table ready");

  // Enrich public_holidays with import-related columns (all nullable → existing rows unaffected).
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS local_name text;`);
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS observed_date date;`);
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS year integer;`);
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS country_code text;`);
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS region_code text;`);
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS type text;`);
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS status text;`);
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'Manual';`);
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS notes text;`);
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS created_by text;`);
  await db.query(`ALTER TABLE public_holidays ADD COLUMN IF NOT EXISTS updated_by text;`);
  // Populate year column for existing rows.
  await db.query(`UPDATE public_holidays SET year = EXTRACT(YEAR FROM date)::integer WHERE year IS NULL;`);
  // Unique constraint on (calendar_id, date, name) to prevent duplicate imports.
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'public_holidays_calendar_date_name_unique'
           AND conrelid = 'public_holidays'::regclass
      ) THEN
        ALTER TABLE public_holidays
          ADD CONSTRAINT public_holidays_calendar_date_name_unique
          UNIQUE (calendar_id, date, name);
      END IF;
    END $$;
  `);
  logger.info("public_holidays enriched columns ready");

  // user_holiday_calendars — assigns a holiday calendar to a member.
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_holiday_calendars (
      id                      serial PRIMARY KEY,
      member_id               integer NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      calendar_id             integer NOT NULL REFERENCES public_holiday_calendars(id) ON DELETE CASCADE,
      workspace_owner_id      text NOT NULL,
      effective_from          date NOT NULL DEFAULT CURRENT_DATE,
      effective_to            date,
      assigned_by_member_id   integer REFERENCES workspace_members(id) ON DELETE SET NULL,
      created_at              timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_holiday_calendars_member_calendar_unique UNIQUE (member_id, calendar_id)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'user_holiday_calendars'
            AND indexname  = 'idx_uhc_member'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_uhc_member
         ON user_holiday_calendars(member_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_uhc_member: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_uhc_member: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("user_holiday_calendars table ready");

  // ── Fleet tables ──────────────────────────────────────────────────────────

  await db.query(`
    CREATE TABLE IF NOT EXISTS fleet_drivers (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      first_name            text NOT NULL,
      last_name             text NOT NULL,
      phone                 text,
      email                 text,
      vehicle_type          text NOT NULL,
      license_number        text,
      status                text NOT NULL DEFAULT 'active',
      notes                 text,
      deleted_at            timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'fleet_drivers'
            AND indexname  = 'idx_fleet_drivers_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_fleet_drivers_workspace
         ON fleet_drivers(workspace_owner_id, status)
         WHERE deleted_at IS NULL;`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_fleet_drivers_workspace: already present — no action needed");
    } else {
      logger.info("idx_fleet_drivers_workspace: was missing — created successfully");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'fleet_drivers'
            AND indexname  = 'idx_fleet_drivers_phone_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_drivers_phone_workspace
         ON fleet_drivers(workspace_owner_id, regexp_replace(phone, '[^+0-9]', '', 'g'))
         WHERE phone IS NOT NULL AND deleted_at IS NULL;`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_fleet_drivers_phone_workspace: already present — no action needed");
    } else {
      logger.info("idx_fleet_drivers_phone_workspace: was missing — created successfully");
    }
  }
  logger.info("fleet_drivers table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS fleet_driver_vehicles (
      id            serial PRIMARY KEY,
      driver_id     integer NOT NULL REFERENCES fleet_drivers(id) ON DELETE CASCADE,
      make          text,
      model         text,
      year          integer,
      plate_number  text,
      vehicle_type  text NOT NULL,
      color         text,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'fleet_driver_vehicles'
            AND indexname  = 'idx_fdv_driver'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_fdv_driver ON fleet_driver_vehicles(driver_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_fdv_driver: already present — no action needed");
    } else {
      logger.info("idx_fdv_driver: was missing — created successfully");
    }
  }
  logger.info("fleet_driver_vehicles table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS fleet_driver_availability (
      id            serial PRIMARY KEY,
      driver_id     integer NOT NULL REFERENCES fleet_drivers(id) ON DELETE CASCADE,
      day_of_week   integer NOT NULL,
      start_time    text NOT NULL,
      end_time      text NOT NULL,
      CONSTRAINT fleet_driver_availability_driver_day_unique UNIQUE (driver_id, day_of_week)
    );
  `);
  logger.info("fleet_driver_availability table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS fleet_driver_order_assignments (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      driver_id           integer NOT NULL REFERENCES fleet_drivers(id) ON DELETE RESTRICT,
      order_reference     text NOT NULL,
      pickup_address      text,
      delivery_address    text,
      status              text NOT NULL DEFAULT 'pending',
      scheduled_at        timestamptz,
      notes               text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'fleet_driver_order_assignments'
            AND indexname  = 'idx_fdoa_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_fdoa_workspace
         ON fleet_driver_order_assignments(workspace_owner_id, created_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_fdoa_workspace: already present — no action needed");
    } else {
      logger.info("idx_fdoa_workspace: was missing — created successfully");
    }
  }
  logger.info("fleet_driver_order_assignments table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS fleet_delivery_events (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      assignment_id       integer NOT NULL REFERENCES fleet_driver_order_assignments(id) ON DELETE CASCADE,
      event_type          text NOT NULL,
      notes               text,
      lat                 numeric(10, 7),
      lng                 numeric(10, 7),
      occurred_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'fleet_delivery_events'
            AND indexname  = 'idx_fde_assignment'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_fde_assignment
         ON fleet_delivery_events(assignment_id, occurred_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_fde_assignment: already present — no action needed");
    } else {
      logger.info("idx_fde_assignment: was missing — created successfully");
    }
  }
  logger.info("fleet_delivery_events table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS fleet_proof_of_delivery (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      assignment_id       integer NOT NULL REFERENCES fleet_driver_order_assignments(id) ON DELETE CASCADE,
      recipient_name      text,
      notes               text,
      signature_data      text,
      has_signature       boolean NOT NULL DEFAULT false,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'fleet_proof_of_delivery'
            AND indexname  = 'idx_fpod_assignment'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_fpod_assignment
         ON fleet_proof_of_delivery(assignment_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_fpod_assignment: already present — no action needed");
    } else {
      logger.info("idx_fpod_assignment: was missing — created successfully");
    }
  }
  logger.info("fleet_proof_of_delivery table ready");

  // Add onboarding/lifecycle columns to fleet_drivers (idempotent).
  await db.query(`
    ALTER TABLE fleet_drivers
      ADD COLUMN IF NOT EXISTS country_code         text NOT NULL DEFAULT '+961',
      ADD COLUMN IF NOT EXISTS onboarding_status    text NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS availability_status  text NOT NULL DEFAULT 'offline',
      ADD COLUMN IF NOT EXISTS deactivated_at       timestamptz,
      ADD COLUMN IF NOT EXISTS deactivation_reason  text,
      ADD COLUMN IF NOT EXISTS taxi_company         text;
  `);
  // Per-driver bearer API tokens (hashed at rest).
  await db.query(`
    CREATE TABLE IF NOT EXISTS fleet_driver_api_tokens (
      id           serial PRIMARY KEY,
      driver_id    integer NOT NULL REFERENCES fleet_drivers(id) ON DELETE CASCADE,
      token_hash   text NOT NULL UNIQUE,
      token_prefix text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      revoked_at   timestamptz,
      last_used_at timestamptz
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_fdat_driver ON fleet_driver_api_tokens(driver_id);`,
  );
  await db.query(`
    ALTER TABLE fleet_driver_api_tokens
      ADD COLUMN IF NOT EXISTS expires_at timestamptz;
  `);
  logger.info("fleet_driver_api_tokens table ready");

  // Controlled, editable list of vehicle types per workspace.
  await db.query(`
    CREATE TABLE IF NOT EXISTS fleet_vehicle_types (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      is_active           boolean NOT NULL DEFAULT true,
      sort_order          integer NOT NULL DEFAULT 0,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fleet_vehicle_types_workspace_name_unique UNIQUE (workspace_owner_id, name)
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_fvt_workspace
       ON fleet_vehicle_types(workspace_owner_id) WHERE is_active = true;`,
  );
  logger.info("fleet_vehicle_types table ready");

  // fleet_driver_transactions — wallet credit/debit ledger entries per driver
  await db.query(`
    CREATE TABLE IF NOT EXISTS fleet_driver_transactions (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id    integer NOT NULL REFERENCES fleet_drivers(id) ON DELETE CASCADE,
      type         text NOT NULL,
      amount_cents integer NOT NULL,
      description  text NOT NULL,
      order_id     text,
      date         text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_fdt_driver
      ON fleet_driver_transactions(driver_id, created_at DESC);
  `);
  logger.info("fleet_driver_transactions table ready");

  // fleet_driver_notifications — push notifications sent to drivers
  await db.query(`
    CREATE TABLE IF NOT EXISTS fleet_driver_notifications (
      id         serial PRIMARY KEY,
      driver_id  integer NOT NULL REFERENCES fleet_drivers(id) ON DELETE CASCADE,
      title      text NOT NULL,
      body       text NOT NULL,
      data       text,
      read_at    timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_fdn_driver
      ON fleet_driver_notifications(driver_id, created_at DESC);
  `);
  logger.info("fleet_driver_notifications table ready");

  // Active columns on fleet_driver_order_assignments (still used by the
  // fleet driver app and order flow).
  await db.query(`
    ALTER TABLE fleet_driver_order_assignments
      ADD COLUMN IF NOT EXISTS accepted_at   timestamptz,
      ADD COLUMN IF NOT EXISTS picked_up_at  timestamptz,
      ADD COLUMN IF NOT EXISTS delivered_at  timestamptz;
  `);

  // The WooCommerce column (fleet_driver_order_assignments.woo_order_id) and the
  // woocommerce_orders / woocommerce_stores tables are RETAINED to keep dev and
  // production schemas aligned for a clean, non-destructive publish migration.
  // Production still holds these objects; the previous CASCADE drops also caused
  // Replit's generated migration to fail validation (DROP TABLE ... CASCADE
  // removed the woo_order_id FK, then a later explicit DROP CONSTRAINT failed
  // because it no longer existed). Do NOT re-enable these drops without a
  // planned, backed-up migration.
  // await db.query(
  //   `ALTER TABLE fleet_driver_order_assignments DROP COLUMN IF EXISTS woo_order_id;`,
  // );
  // for (const wooTable of [
  //   "synced_woocommerce_orders",
  //   "woocommerce_order_gifts",
  //   "woocommerce_order_items",
  //   "woocommerce_order_notes",
  //   "woocommerce_order_status_history",
  //   "woocommerce_orders",
  //   "woocommerce_stores",
  // ]) {
  //   await db.query(`DROP TABLE IF EXISTS ${wooTable} CASCADE;`);
  // }

  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_fdoa_driver
       ON fleet_driver_order_assignments(driver_id, status);`,
  );

  // Add fields to proof_of_delivery for image, recipient, geolocation, etc.
  await db.query(`
    ALTER TABLE fleet_proof_of_delivery
      ADD COLUMN IF NOT EXISTS image_url     text,
      ADD COLUMN IF NOT EXISTS latitude      numeric(10,7),
      ADD COLUMN IF NOT EXISTS longitude     numeric(10,7),
      ADD COLUMN IF NOT EXISTS delivered_at  timestamptz,
      ADD COLUMN IF NOT EXISTS driver_id     integer REFERENCES fleet_drivers(id) ON DELETE SET NULL;
  `);

  // NOTE: the legacy per-workspace `cities` table is intentionally NO LONGER
  // created here. Its data was migrated into `delivery_cities` long ago, and
  // both the legacy table and its `cities_legacy_bak` backup have since been
  // permanently dropped from every database. A fresh DB must never carry the
  // legacy table.

  // Per-product per-city availability.
  await db.query(`
    CREATE TABLE IF NOT EXISTS product_city_availability (
      id            serial PRIMARY KEY,
      product_id    integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      city_id       integer NOT NULL,
      is_available  boolean NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pca_product_city
       ON product_city_availability(product_id, city_id);`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_pca_city
       ON product_city_availability(city_id);`,
  );
  // product_city_availability.city_id originally referenced the legacy `cities`
  // table (now migrated to delivery_cities and emptied). Drop that FK so the
  // column can hold delivery_cities IDs. We intentionally do NOT add a new FK to
  // delivery_cities (see the cities→delivery_cities migration note below): the
  // column is filtered against delivery_cities at query time instead.
  await db.query(
    `ALTER TABLE product_city_availability
       DROP CONSTRAINT IF EXISTS product_city_availability_city_id_fkey;`,
  );
  logger.info("product_city_availability table ready");

  // Per-product per-country availability. Parallel to product_city_availability
  // but keyed by ISO 3166-1 alpha-2 country code (uppercase), consistent with
  // delivery_cities.country_code. Default-on: a product is available in every
  // enabled workspace country unless an explicit row sets is_available=false.
  // No FK — the country universe comes from workspace_settings.available_countries.
  await db.query(`
    CREATE TABLE IF NOT EXISTS product_country_availability (
      id            serial PRIMARY KEY,
      product_id    integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      country_code  text NOT NULL,
      is_available  boolean NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pcountrya_product_country
       ON product_country_availability(product_id, country_code);`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_pcountrya_country
       ON product_country_availability(country_code);`,
  );
  logger.info("product_country_availability table ready");

  // Homepage banners — admin-managed banners targeted by country/city for the public storefront.
  await db.query(`
    CREATE TABLE IF NOT EXISTS homepage_banners (
      id                      serial PRIMARY KEY,
      workspace_owner_id      text NOT NULL,
      internal_name           text NOT NULL,
      title                   text,
      headline                text,
      subtitle                text,
      cta_text                text,
      country_codes           text[] NOT NULL DEFAULT '{}',
      city_ids                integer[] NOT NULL DEFAULT '{}',
      is_global_for_country   boolean NOT NULL DEFAULT false,
      desktop_enabled         boolean NOT NULL DEFAULT false,
      desktop_media_type      text,
      desktop_media_url       text,
      desktop_fallback_url    text,
      desktop_link_url        text,
      mobile_enabled          boolean NOT NULL DEFAULT false,
      mobile_media_type       text,
      mobile_media_url        text,
      mobile_fallback_url     text,
      mobile_link_url         text,
      start_at                timestamptz,
      end_at                  timestamptz,
      timezone                text NOT NULL DEFAULT 'UTC',
      sort_order              integer NOT NULL DEFAULT 0,
      priority                integer NOT NULL DEFAULT 0,
      is_active               boolean NOT NULL DEFAULT false,
      activated_at            timestamptz,
      created_by              text,
      updated_by              text,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Public, auth-free copies of banner media (mirrors products.image_public_path).
  // The storefront serves these so banner images load on the public website.
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS desktop_media_public_path text;`,
  );
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS desktop_fallback_public_path text;`,
  );
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS mobile_media_public_path text;`,
  );
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS mobile_fallback_public_path text;`,
  );
  // Structured banner-level link target (replaces free-text per-side link URLs).
  // link_kind: 'category' | 'occasion'; link_attribute_id references the picked
  // catalog_categories/occasions row; link_slug is the resolved slug snapshot.
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS link_kind text;`,
  );
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS link_attribute_id integer;`,
  );
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS link_slug text;`,
  );
  // Language targeting (admin editor redesign).
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS languages text[] NOT NULL DEFAULT '{en,ar}';`,
  );
  // Structured click destination — replaces per-side link_url in the admin UI.
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS destination_type text;`,
  );
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS destination_value text;`,
  );
  // Status override — 'paused' when admin manually pauses a live/scheduled banner.
  await db.query(
    `ALTER TABLE homepage_banners ADD COLUMN IF NOT EXISTS status_override text;`,
  );
  // Map legacy active=false (never activated) rows: already correct as Draft.
  // Map legacy active=false (was activated): already correct as Inactive.
  // No data migration needed — computeBannerStatus derives the correct status.
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_homepage_banners_workspace
       ON homepage_banners(workspace_owner_id, created_at DESC);`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_homepage_banners_storefront
       ON homepage_banners(is_active, start_at, end_at)
       WHERE is_active = true;`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_homepage_banners_country
       ON homepage_banners USING GIN (country_codes);`,
  );
  logger.info("homepage_banners table ready");

  // Customers — workspace-scoped customer records derived from order data.
  await db.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      first_name          text,
      last_name           text,
      email               text,
      phone               text,
      country             text,
      city                text,
      notes               text,
      source              text,
      total_orders        integer NOT NULL DEFAULT 0,
      total_spent         numeric(14,2) NOT NULL DEFAULT 0,
      last_order_at       timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Unique on (workspace, lowercased email) — partial so multiple NULL emails are allowed.
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS customers_workspace_email_unique
       ON customers(workspace_owner_id, email)
       WHERE email IS NOT NULL;`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_customers_workspace
       ON customers(workspace_owner_id);`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_customers_workspace_phone
       ON customers(workspace_owner_id, phone)
       WHERE phone IS NOT NULL;`,
  );
  logger.info("customers table ready");

  // ── Legacy object preservation (WooCommerce + per-product `cities`) ─────────
  // These legacy objects are NO LONGER used by application runtime code, but they
  // still exist in the production database WITH DATA. They are recreated here
  // idempotently (CREATE ... IF NOT EXISTS) so that development and production
  // schemas stay aligned and Replit's publish-time migration remains clean and
  // NON-DESTRUCTIVE. Previously these were dropped on startup, which (a) deleted
  // production data on deploy and (b) produced an invalid publish migration
  // (DROP TABLE woocommerce_orders CASCADE removed the woo_order_id FK, then a
  // later explicit DROP CONSTRAINT failed). Do NOT convert these back to drops
  // without a planned, backed-up migration. Placed after customers/locations/
  // products/fleet so all FK targets already exist.
  await db.query(`
    CREATE TABLE IF NOT EXISTS woocommerce_stores (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      name               text NOT NULL,
      store_url          text NOT NULL,
      consumer_key       text NOT NULL,
      consumer_secret    text NOT NULL,
      last_synced_at     timestamptz,
      created_at         timestamptz DEFAULT now(),
      CONSTRAINT wc_stores_owner_url_unique UNIQUE (workspace_owner_id, store_url)
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS woocommerce_orders (
      id               serial PRIMARY KEY,
      store_id         integer NOT NULL,
      woo_order_id     integer NOT NULL,
      status           text NOT NULL,
      customer_name    text,
      customer_email   text,
      billing_address  jsonb,
      shipping_address jsonb,
      total            numeric(12,2),
      currency         text,
      payment_method   text,
      line_items       jsonb,
      taxes            jsonb,
      shipping_fees    numeric(12,2),
      woo_created_at   timestamptz,
      woo_updated_at   timestamptz,
      synced_at        timestamptz NOT NULL DEFAULT now(),
      customer_id      integer,
      location_id      integer,
      CONSTRAINT woocommerce_orders_store_woo_order_unique UNIQUE (store_id, woo_order_id),
      CONSTRAINT woocommerce_orders_store_id_fkey FOREIGN KEY (store_id) REFERENCES woocommerce_stores(id) ON DELETE CASCADE,
      CONSTRAINT woocommerce_orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
      CONSTRAINT woocommerce_orders_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS cities (
      id                           serial PRIMARY KEY,
      workspace_owner_id           text NOT NULL,
      country                      text NOT NULL,
      name                         text NOT NULL,
      slug                         text NOT NULL,
      is_active                    boolean NOT NULL DEFAULT true,
      sort_order                   integer NOT NULL DEFAULT 0,
      created_at                   timestamptz NOT NULL DEFAULT now(),
      updated_at                   timestamptz NOT NULL DEFAULT now(),
      delivery_fee                 numeric(10,2) NOT NULL DEFAULT '0'::numeric,
      free_delivery_enabled        boolean NOT NULL DEFAULT false,
      free_delivery_threshold      numeric(10,2) NOT NULL DEFAULT '0'::numeric,
      express_delivery_enabled     boolean NOT NULL DEFAULT false,
      express_delivery_cutoff_time time without time zone,
      express_delivery_fee         numeric(10,2) NOT NULL DEFAULT '0'::numeric
    );
  `);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category text;`);
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS woo_product_id integer;`);
  await db.query(
    `ALTER TABLE fleet_driver_order_assignments ADD COLUMN IF NOT EXISTS woo_order_id integer;`,
  );
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fleet_driver_order_assignments_woo_order_id_fkey'
      ) THEN
        ALTER TABLE fleet_driver_order_assignments
          ADD CONSTRAINT fleet_driver_order_assignments_woo_order_id_fkey
          FOREIGN KEY (woo_order_id) REFERENCES woocommerce_orders(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cities_owner_country ON cities(workspace_owner_id, country);`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cities_owner_country_slug ON cities(workspace_owner_id, country, slug);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wc_stores_owner ON woocommerce_stores(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wc_orders_store ON woocommerce_orders(store_id, woo_created_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_woocommerce_orders_customer ON woocommerce_orders(customer_id) WHERE customer_id IS NOT NULL;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_woocommerce_orders_location ON woocommerce_orders(location_id, woo_created_at) WHERE location_id IS NOT NULL;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fdoa_woo_order ON fleet_driver_order_assignments(woo_order_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_products_category_trgm ON products USING gin (lower(category) gin_trgm_ops);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_products_workspace_woo_product ON products(workspace_owner_id, woo_product_id) WHERE woo_product_id IS NOT NULL;`);
  logger.info("legacy woo/cities objects preserved (dev↔prod schema alignment)");

  // Per-workspace country flag overrides. When present, the override URL
  // wins over the bundled `/flags/<code>.svg` default for that country.
  await db.query(`
    CREATE TABLE IF NOT EXISTS country_flag_overrides (
      workspace_owner_id text NOT NULL,
      country_code       text NOT NULL,
      image_url          text NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_owner_id, country_code)
    );
  `);
  logger.info("country_flag_overrides table ready");

  // Exchange rates — stored once globally (workspace_owner_id = '__global__').
  // workspace_owner_id is kept for future per-workspace overrides.
  await db.query(`
    CREATE TABLE IF NOT EXISTS exchange_rates (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      base_currency       text NOT NULL,
      target_currency     text NOT NULL,
      rate                numeric(20, 10) NOT NULL,
      provider            text NOT NULL DEFAULT 'exchangerate-api.com',
      fetched_at          timestamptz NOT NULL DEFAULT now(),
      created_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT exchange_rates_workspace_pair_unique
        UNIQUE (workspace_owner_id, base_currency, target_currency)
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_exchange_rates_owner
       ON exchange_rates(workspace_owner_id);`,
  );
  // Keep LBP available even when the provider omits it, while repairing stale
  // reversed rows and preserving the represented value of manual overrides.
  await repairGlobalLbpRate();
  logger.info("exchange_rates table ready");

  // Exchange rate settings — per-workspace markup and rounding rule configuration.
  await db.query(`
    CREATE TABLE IF NOT EXISTS exchange_rate_settings (
      workspace_owner_id          text PRIMARY KEY,
      default_markup_percentage   numeric(6, 3) NOT NULL DEFAULT 0,
      rounding_rule               text NOT NULL DEFAULT 'round_up_whole',
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz NOT NULL DEFAULT now()
    );
  `);
  logger.info("exchange_rate_settings table ready");

  // Add base_currency to exchange_rate_settings if not already present.
  await db.query(
    `ALTER TABLE exchange_rate_settings ADD COLUMN IF NOT EXISTS base_currency text NOT NULL DEFAULT 'USD';`,
  );
  logger.info("exchange_rate_settings.base_currency column ready");

  // Conversion audit columns on payment_links (idempotent).
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS original_amount numeric(20,4);`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS original_currency text;`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS official_exchange_rate numeric(20,10);`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS markup_percentage_used numeric(6,3);`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS converted_amount_exact numeric(20,4);`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS final_amount_charged numeric(20,4);`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS converted_currency text;`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS rounding_rule_used text;`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS exchange_rate_fetched_at timestamptz;`);
  logger.info("payment_links conversion audit columns ready");

  await db.query(`
    ALTER TABLE payment_links
      ADD COLUMN IF NOT EXISTS google_click_id_type text,
      ADD COLUMN IF NOT EXISTS google_click_id text,
      ADD COLUMN IF NOT EXISTS google_click_captured_at timestamptz
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS payment_link_conversions (
      id bigserial PRIMARY KEY,
      payment_link_id integer NOT NULL REFERENCES payment_links(id) ON DELETE CASCADE,
      transaction_id text NOT NULL,
      destination_country text NOT NULL,
      click_id_type text NOT NULL,
      click_id text NOT NULL,
      conversion_value numeric(20,4) NOT NULL,
      currency text NOT NULL,
      conversion_time timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      uploaded_at timestamptz,
      last_error text,
      failure_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(
    `ALTER TABLE payment_link_conversions ADD COLUMN IF NOT EXISTS failure_reason text;`,
  );
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_link_conversions_transaction
      ON payment_link_conversions(transaction_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_payment_link_conversions_retry
      ON payment_link_conversions(status, next_attempt_at)
  `);
  logger.info("payment link Ads conversion persistence ready");

  // Sender details columns on payment_links — collected on the public pay page before checkout.
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS sender_first_name text;`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS sender_last_name text;`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS sender_phone_country_code text;`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS sender_phone text;`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS sender_email text;`);
  await db.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS sender_submitted_at timestamptz;`);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'payment_links'
            AND indexname  = 'idx_payment_links_sender_email'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_payment_links_sender_email
         ON payment_links(sender_email)
         WHERE sender_email IS NOT NULL;`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_payment_links_sender_email: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_payment_links_sender_email: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("payment_links sender columns ready");

  // ── Delivery cities (Task #83) ────────────────────────────────────────────
  // Per-workspace delivery activation per country (keyed by uppercase ISO 3166-1
  // alpha-2 code). Distinct from `cities` (which scopes per-product
  // availability) — these tables drive the customer-app delivery selector.
  await db.query(`
    CREATE TABLE IF NOT EXISTS delivery_country_settings (
      workspace_owner_id   text NOT NULL,
      country_code         text NOT NULL,
      delivery_active      boolean NOT NULL DEFAULT false,
      delivery_sort_order  integer NOT NULL DEFAULT 0,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_owner_id, country_code)
    );
  `);
  logger.info("delivery_country_settings table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS delivery_cities (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      country_code        text NOT NULL,
      name                text NOT NULL,
      slug                text NOT NULL,
      sort_order          integer NOT NULL DEFAULT 0,
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_cities_owner_country_slug
       ON delivery_cities(workspace_owner_id, country_code, slug);`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_delivery_cities_owner_country
       ON delivery_cities(workspace_owner_id, country_code);`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_delivery_cities_owner_country_active
       ON delivery_cities(workspace_owner_id, country_code, is_active);`,
  );
  logger.info("delivery_cities table ready");

  // Idempotent UAE delivery cities seed for any workspace whose
  // available_countries contains "United Arab Emirates". Never overwrites
  // admin-edited rows; never seeds delivery_active state.
  await db.query(`
    WITH targets AS (
      SELECT workspace_owner_id
        FROM workspace_settings
       WHERE 'United Arab Emirates' = ANY(available_countries)
    ),
    seeds(name, slug, sort_order) AS (
      VALUES
        ('Dubai',           'dubai',            1),
        ('Abu Dhabi',       'abu-dhabi',        2),
        ('Sharjah',         'sharjah',          3),
        ('Ajman',           'ajman',            4),
        ('Ras Al Khaimah',  'ras-al-khaimah',   5),
        ('Fujairah',        'fujairah',         6),
        ('Umm Al Quwain',   'umm-al-quwain',    7),
        ('Al Ain',          'al-ain',           8)
    )
    INSERT INTO delivery_cities
      (workspace_owner_id, country_code, name, slug, sort_order, is_active)
    SELECT t.workspace_owner_id, 'AE', s.name, s.slug, s.sort_order, true
      FROM targets t CROSS JOIN seeds s
      ON CONFLICT (workspace_owner_id, country_code, slug) DO NOTHING;
  `);
  logger.info("delivery_cities UAE seed applied");

  // Idempotent Lebanon delivery cities seed for any workspace whose
  // available_countries contains "Lebanon". Never overwrites admin-edited rows.
  await db.query(`
    WITH targets AS (
      SELECT workspace_owner_id
        FROM workspace_settings
       WHERE 'Lebanon' = ANY(available_countries)
    ),
    seeds(name, slug, sort_order, is_active) AS (
      VALUES
        ('Akkar',          'akkar',          0, true),
        ('Aley',           'aley',           1, true),
        ('Baabda',         'baabda',         2, true),
        ('Baalbeck',       'baalbeck',       3, false),
        ('Batroun',        'batroun',        4, true),
        ('Bcharee',        'bcharee',        5, true),
        ('Beirut',         'beirut',         6, true),
        ('Bent Jbeil',     'bent-jbeil',     7, false),
        ('Chouf',          'chouf',          8, true),
        ('Hasbaya',        'hasbaya',        9, false),
        ('Hermel',         'hermel',        10, false),
        ('Jbeil',          'jbeil',         11, true),
        ('Jezzine',        'jezzine',       12, false),
        ('Kesserwan',      'kesserwan',     13, true),
        ('Koura',          'koura',         14, true),
        ('Marjayoun',      'marjayoun',     15, false),
        ('Metn',           'metn',          16, true),
        ('Minnieh-Dennaye','minnieh-dennaye',17, true),
        ('Nabatieh',       'nabatieh',      18, false),
        ('Rachaya',        'rachaya',       19, true),
        ('Saida',          'saida',         20, true),
        ('Tripoli',        'tripoli',       21, true),
        ('Tyre',           'tyre',          22, false),
        ('West Bekaa',     'west-bekaa',    23, true),
        ('Zahle',          'zahle',         24, true),
        ('Zghorta',        'zghorta',       25, true)
    )
    INSERT INTO delivery_cities
      (workspace_owner_id, country_code, name, slug, sort_order, is_active)
    SELECT t.workspace_owner_id, 'LB', s.name, s.slug, s.sort_order, s.is_active
      FROM targets t CROSS JOIN seeds s
      ON CONFLICT (workspace_owner_id, country_code, slug) DO NOTHING;
  `);
  logger.info("delivery_cities Lebanon seed applied");

  // Idempotent Cyprus delivery cities seed for any workspace whose
  // available_countries contains "Cyprus". Never overwrites admin-edited rows.
  await db.query(`
    WITH targets AS (
      SELECT workspace_owner_id
        FROM workspace_settings
       WHERE 'Cyprus' = ANY(available_countries)
    ),
    seeds(name, slug, sort_order, is_active) AS (
      VALUES
        ('Nicosia',     'nicosia',     0, true),
        ('Larnaca',     'larnaca',     1, true),
        ('Paphos',      'paphos',      2, true),
        ('Limassol',    'limassol',    3, true),
        ('Ammachostos', 'ammachostos', 4, true)
    )
    INSERT INTO delivery_cities
      (workspace_owner_id, country_code, name, slug, sort_order, is_active)
    SELECT t.workspace_owner_id, 'CY', s.name, s.slug, s.sort_order, s.is_active
      FROM targets t CROSS JOIN seeds s
      ON CONFLICT (workspace_owner_id, country_code, slug) DO NOTHING;
  `);
  logger.info("delivery_cities Cyprus seed applied");

  // Seed delivery_country_settings for Lebanon, UAE, and Cyprus on the
  // Presentail workspace (workspace_owner_id = 'user_3DCcbYtdoRYrTOqHwKxb1gwXxJR')
  // so all three countries are delivery-enabled.
  await db.query(`
    INSERT INTO delivery_country_settings
      (workspace_owner_id, country_code, delivery_active, delivery_sort_order)
    VALUES
      ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', true, 0),
      ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'AE', true, 1),
      ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'CY', true, 2)
    ON CONFLICT (workspace_owner_id, country_code) DO UPDATE
      SET delivery_active = true,
          delivery_sort_order = EXCLUDED.delivery_sort_order;
  `);
  logger.info("delivery_country_settings presentail seed applied");

  // Add clerk_user_id column to fleet_drivers (nullable — existing rows unaffected).
  await db.query(
    `ALTER TABLE fleet_drivers ADD COLUMN IF NOT EXISTS clerk_user_id text;`,
  );
  // Sparse unique index: only one driver can own a given Clerk user ID, but
  // NULL values are excluded so drivers without a Clerk link can coexist freely.
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_drivers_clerk_user_id
       ON fleet_drivers(clerk_user_id)
      WHERE clerk_user_id IS NOT NULL;`,
  );
  logger.info("fleet_drivers.clerk_user_id column and unique index ready");

  // ── channel_image_configs ─────────────────────────────────────────────────
  // Unified image dimension config per channel per image type (product/banner/logo).
  await db.query(`
    CREATE TABLE IF NOT EXISTS channel_image_configs (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      channel_id          integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      image_type          text NOT NULL CHECK (image_type IN ('product', 'banner', 'logo')),
      width_px            integer NOT NULL CHECK (width_px > 0),
      height_px           integer NOT NULL CHECK (height_px > 0),
      output_format       text NOT NULL DEFAULT 'jpeg' CHECK (output_format IN ('jpeg', 'png', 'webp')),
      created_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT channel_image_configs_unique UNIQUE (channel_id, image_type)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'channel_image_configs'
            AND indexname  = 'idx_channel_image_configs_channel'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_channel_image_configs_channel
         ON channel_image_configs(workspace_owner_id, channel_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_channel_image_configs_channel: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_channel_image_configs_channel: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("channel_image_configs table ready");

  // ── channel_contacts ──────────────────────────────────────────────────────
  // Contacts (account managers, BDMs, etc.) per channel.
  await db.query(`
    CREATE TABLE IF NOT EXISTS channel_contacts (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      channel_id          integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      first_name          text NOT NULL,
      last_name           text,
      email               text,
      phone               text,
      title               text,
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'channel_contacts'
            AND indexname  = 'idx_channel_contacts_channel'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_channel_contacts_channel
         ON channel_contacts(workspace_owner_id, channel_id)
         WHERE is_active = true;`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_channel_contacts_channel: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_channel_contacts_channel: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("channel_contacts table ready");

  // ── Base item stock adjustments (Task #192) ───────────────────────────────
  // Audit trail for every stock level change. Each row records the delta,
  // the reason, an optional free-text note, a snapshot of stock_after, and
  // the Clerk user who made the change.
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_stock_adjustments (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      base_item_id        integer NOT NULL REFERENCES base_items(id) ON DELETE CASCADE,
      quantity_change     numeric NOT NULL,
      reason              text NOT NULL,
      note                text,
      stock_after         numeric NOT NULL,
      created_by_user_id  text,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    ALTER TABLE base_item_stock_adjustments
      ADD COLUMN IF NOT EXISTS location_id integer REFERENCES locations(id);
  `);
  // Guard: purchase_orders may not exist yet on a fresh database at this
  // point in the init sequence — the table is created further below.
  // On an existing deployment it already exists, so we run the ADD COLUMN
  // immediately; on a fresh deployment the column will be added after
  // purchase_orders is created (see the idempotent ALTER below).
  await db.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'purchase_orders'
      ) THEN
        ALTER TABLE base_item_stock_adjustments
          ADD COLUMN IF NOT EXISTS purchase_order_id integer
            REFERENCES purchase_orders(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_item_stock_adjustments'
            AND indexname  = 'idx_bisa_base_item'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bisa_base_item
         ON base_item_stock_adjustments(base_item_id, created_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_bisa_base_item: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_bisa_base_item: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_item_stock_adjustments'
            AND indexname  = 'idx_bisa_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bisa_workspace
         ON base_item_stock_adjustments(workspace_owner_id, created_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_bisa_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_bisa_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("base_item_stock_adjustments table ready");

  // Budget configurations — saved budget planner setups per workspace.
  await db.query(`
    CREATE TABLE IF NOT EXISTS budget_configs (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      month               integer NOT NULL,
      year                integer NOT NULL,
      start_date          date NOT NULL,
      end_date            date NOT NULL,
      channels            jsonb NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'budget_configs'
            AND indexname  = 'idx_budget_configs_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_budget_configs_workspace
         ON budget_configs(workspace_owner_id, created_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_budget_configs_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_budget_configs_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("budget_configs table ready");

  // Add currency column to budget_configs if missing (existing rows default to 'AED').
  await db.query(`ALTER TABLE budget_configs ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'AED';`);
  logger.info("budget_configs.currency column ready");

  // Add start_date / end_date columns if missing (table may pre-date Task #270 which only used
  // CREATE TABLE IF NOT EXISTS and thus never added these columns to an already-existing table).
  await db.query(`ALTER TABLE budget_configs ADD COLUMN IF NOT EXISTS start_date date;`);
  await db.query(`ALTER TABLE budget_configs ADD COLUMN IF NOT EXISTS end_date date;`);
  // Backfill any NULLs using the stored month/year: start = first day of month, end = last day.
  await db.query(`
    UPDATE budget_configs
       SET start_date = make_date(year, month, 1),
           end_date   = (make_date(year, month, 1) + interval '1 month - 1 day')::date
     WHERE start_date IS NULL OR end_date IS NULL;
  `);
  logger.info("budget_configs.start_date / end_date columns ready (nulls backfilled)");

  // Migrate allowed_pages: rename 'budget-planner' → 'marketing-budget-planner' in all workspace roles.
  {
    const migResult = await db.query(`
      UPDATE workspace_roles
         SET allowed_pages = (
               SELECT jsonb_agg(
                 CASE WHEN elem = '"budget-planner"'::jsonb
                      THEN '"marketing-budget-planner"'::jsonb
                      ELSE elem
                 END
               )
               FROM jsonb_array_elements(allowed_pages) AS elem
             )
       WHERE allowed_pages @> '["budget-planner"]'::jsonb
    `);
    if (migResult.rowCount && migResult.rowCount > 0) {
      logger.info(`budget-planner → marketing-budget-planner migration: updated ${migResult.rowCount} role(s)`);
    } else {
      logger.info("budget-planner → marketing-budget-planner migration: no roles needed update");
    }
  }

  // ── One-time: reconnect adnan's new Clerk ID to the existing workspace ───────
  // When adnan@presentail.com signed into the new Clerk instance, a new user ID
  // (user_3DOX9of9c6XR9kU8uMya52QAzpC) was issued and claimMembership
  // auto-provisioned a fresh empty workspace.  All 122 products and other data
  // belong to the original workspace (workspace_owner_id =
  // user_3DCcbYtdoRYrTOqHwKxb1gwXxJR).  This migration:
  //   1. Deletes the empty auto-created workspace row for the new Clerk ID.
  //   2. Updates the original owner row to accept the new Clerk ID so
  //      findMembership() resolves to the correct workspace going forward.
  // Idempotent: if the empty row is already gone the UPDATE is a no-op.
  {
    const OLD_WORKSPACE_OWNER = 'user_3DCcbYtdoRYrTOqHwKxb1gwXxJR';
    const NEW_CLERK_ID        = 'user_3DOX9of9c6XR9kU8uMya52QAzpC';

    const ghostRow = await db.query<{ id: number }>(
      `SELECT id FROM workspace_members
        WHERE workspace_owner_id = $1 AND member_user_id = $1
        LIMIT 1`,
      [NEW_CLERK_ID],
    );

    if (ghostRow.rows[0]) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // Remove the ghost empty-workspace row first so the unique index on
        // member_user_id doesn't block the UPDATE below.
        await client.query(
          `DELETE FROM workspace_members WHERE workspace_owner_id = $1 AND member_user_id = $1`,
          [NEW_CLERK_ID],
        );
        // Point the original owner row at the new Clerk ID.
        const updated = await client.query(
          `UPDATE workspace_members
              SET member_user_id = $1
            WHERE workspace_owner_id = $2
              AND member_email       = 'adnan@presentail.com'`,
          [NEW_CLERK_ID, OLD_WORKSPACE_OWNER],
        );
        await client.query('COMMIT');
        logger.info(
          `adnan-workspace-relink: deleted ghost workspace, relinked ${updated.rowCount} owner row(s) to new Clerk ID`,
        );
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ err }, 'adnan-workspace-relink: transaction failed, rolled back');
      } finally {
        client.release();
      }
    } else {
      logger.info('adnan-workspace-relink: already resolved — no ghost workspace found');
    }
  }

  // ── Clerk ID re-link: tania@presentail.com ───────────────────────────────────
  // tania@presentail.com auto-provisioned a ghost workspace before being invited
  // to the main workspace.  Deleting the ghost row lets claimMembership's pending-
  // invite path claim the migrated member row on her next sign-in.
  {
    const GHOST_USER = 'user_3DObat2jByKU7EAuihNfWGoxuWx';
    const deleted = await db.query(
      `DELETE FROM workspace_members WHERE workspace_owner_id = $1 AND member_user_id = $1`,
      [GHOST_USER],
    );
    if (deleted.rowCount && deleted.rowCount > 0) {
      logger.info('tania-workspace-relink: deleted ghost workspace row');
    } else {
      logger.info('tania-workspace-relink: already resolved — no ghost workspace found');
    }
  }

  // ── Clerk ID re-link: sara@presentail.com ────────────────────────────────────
  // sara@presentail.com signed in with a new Clerk ID after the tenant migration,
  // creating a ghost workspace.  Her original member row (old Clerk ID) still
  // points to the main workspace.  This migration: (1) removes the ghost row,
  // (2) re-points the original member row to her new Clerk ID.
  {
    const OLD_USER  = 'user_3DFgiaJD1oC0ZjuaAbw56WvDSZE';
    const NEW_USER  = 'user_3DZQWsKQDTF3BkKfU3OSGwbiIiL';

    const ghostRow = await db.query<{ id: number }>(
      `SELECT id FROM workspace_members WHERE workspace_owner_id = $1 AND member_user_id = $1 LIMIT 1`,
      [NEW_USER],
    );
    if (ghostRow.rows[0]) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM workspace_members WHERE workspace_owner_id = $1 AND member_user_id = $1`,
          [NEW_USER],
        );
        const updated = await client.query(
          `UPDATE workspace_members SET member_user_id = $1 WHERE member_user_id = $2`,
          [NEW_USER, OLD_USER],
        );
        await client.query('COMMIT');
        logger.info(
          `sara-workspace-relink: deleted ghost, relinked ${updated.rowCount} row(s) to new Clerk ID`,
        );
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ err }, 'sara-workspace-relink: transaction failed, rolled back');
      } finally {
        client.release();
      }
    } else {
      logger.info('sara-workspace-relink: already resolved — no ghost workspace found');
    }
  }

  // ── Clerk ID re-link: sami.zaarour@presentail.com ────────────────────────────
  // Same pattern as sara: ghost workspace created on new Clerk ID sign-in, while
  // the original member row still exists under the old Clerk ID.
  {
    const OLD_USER  = 'user_3DFvVMcsHzdBtEY02zVXzoJ1xwZ';
    const NEW_USER  = 'user_3DR4msBJbJX7apY1xp9wEXkpo40';

    const ghostRow = await db.query<{ id: number }>(
      `SELECT id FROM workspace_members WHERE workspace_owner_id = $1 AND member_user_id = $1 LIMIT 1`,
      [NEW_USER],
    );
    if (ghostRow.rows[0]) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM workspace_members WHERE workspace_owner_id = $1 AND member_user_id = $1`,
          [NEW_USER],
        );
        const updated = await client.query(
          `UPDATE workspace_members SET member_user_id = $1 WHERE member_user_id = $2`,
          [NEW_USER, OLD_USER],
        );
        await client.query('COMMIT');
        logger.info(
          `sami-workspace-relink: deleted ghost, relinked ${updated.rowCount} row(s) to new Clerk ID`,
        );
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ err }, 'sami-workspace-relink: transaction failed, rolled back');
      } finally {
        client.release();
      }
    } else {
      logger.info('sami-workspace-relink: already resolved — no ghost workspace found');
    }
  }

  // ── One-time: bulk Clerk-instance membership reconciliation (Aug 3 2026) ─────
  // Approved row-by-row by the workspace owner. After the backend moved to the
  // correct Clerk production instance (clerk.presentail.com), most memberships in
  // the canonical main workspace (user_3DCcbYtdoRYrTOqHwKxb1gwXxJR) still carried
  // Clerk user IDs from before. This block re-points each membership to the
  // user's current Clerk ID, matched by verified primary email against the
  // correct instance. It changes ONLY workspace_members.member_user_id — roles,
  // permissions, membership IDs, workspaces, and all operational data untouched.
  //
  // Special case ahmad@presentail.com: his current Clerk ID was attached to his
  // own pre-existing EMPTY solo workspace (verified: zero operational rows), so
  // that row is detached (member_user_id/joined_at NULLed — the workspace itself
  // is kept) to free the ID for his canonical owner membership.
  //
  // Idempotent: every statement is guarded by (row id AND expected old value);
  // once applied, all guards miss and it's a no-op. A full pre-change backup of
  // workspace_members is snapshotted once into workspace_members_backup_20260803.
  {
    const RELINKS: Array<{ rowId: number; email: string; oldId: string; newId: string }> = [
      { rowId: 48,  email: 'adnan@presentail.com',        oldId: 'user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', newId: 'user_3DOX9of9c6XR9kU8uMya52QAzpC' },
      { rowId: 69,  email: 'sara@presentail.com',         oldId: 'user_3DFgiaJD1oC0ZjuaAbw56WvDSZE', newId: 'user_3DZQWsKQDTF3BkKfU3OSGwbiIiL' },
      { rowId: 70,  email: 'mohammad@presentail.com',     oldId: 'user_3DFWqZllVkBsPtKzCyxS2xwgvzt', newId: 'user_3DQnWcbYCPRPeiKnMEWTr3dkv8a' },
      { rowId: 73,  email: 'sami.zaarour@presentail.com', oldId: 'user_3DFvVMcsHzdBtEY02zVXzoJ1xwZ', newId: 'user_3DR4msBJbJX7apY1xp9wEXkpo40' },
      { rowId: 80,  email: 'tania@presentail.com',        oldId: 'user_3DFWcsfTA6H3bgVZBSjYzb0nanx', newId: 'user_3DObat2jByKU7EAuihNfWGoxuWx' },
      { rowId: 88,  email: 'karen@presentail.com',        oldId: 'user_3EZPXDvHsLUCmTgVWi0208raxh5', newId: 'user_3DtB8k5fOYc7C3dsG01oaeh9oxg' },
      { rowId: 90,  email: 'melissa@presentail.com',      oldId: 'user_3FqVFjuMjkHJEltiybwdMBhnus5', newId: 'user_3DtUsoYbac0QNpOxoHqozyK1iQB' },
      { rowId: 91,  email: 'ali@presentail.com',          oldId: 'user_3EZbX3N1yA8fLQ9OOtHGcEXFKx9', newId: 'user_3DwGS60WVd9fnSXMXYGU67edEmm' },
      { rowId: 92,  email: 'sophia.rammal@presentail.com',oldId: 'user_3EgS1BURrlIRFkEGRdmykK4MmX2', newId: 'user_3DtUYc0hmr8pGflrAaJWiueLfAq' },
      { rowId: 95,  email: 'bassel@presentail.com',       oldId: 'user_3EZQc4StqKdXvBfzdDutJcIMJYT', newId: 'user_3ECr04lYWAM01r2xNCY6Xk8IKaD' },
      { rowId: 101, email: 'taleb@presentail.com',        oldId: 'user_3EWmcHCwXK4X2ihqJPqwu7YjbBB', newId: 'user_3EBoKbIwm2kCtm6L2fWzflvnqel' },
      // ahmad@ runs LAST: row 75 detach below frees this ID first.
      { rowId: 94,  email: 'ahmad@presentail.com',        oldId: 'user_3EX2WPVLJCWGKLyo665q4kTodDQ', newId: 'user_3DRR3R8a1MqqW5wcsEerqc90nq1' },
    ];
    const AHMAD_SOLO_ROW_ID = 75;
    const AHMAD_NEW_ID = 'user_3DRR3R8a1MqqW5wcsEerqc90nq1';

    // Quick pre-check: anything left to do?
    const pending = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM workspace_members
        WHERE (id = $1 AND member_user_id = $2)
           OR (id, member_user_id) IN (${RELINKS.map((r, i) => `($${i * 2 + 3}::int, $${i * 2 + 4})`).join(',')})`,
      [AHMAD_SOLO_ROW_ID, AHMAD_NEW_ID, ...RELINKS.flatMap((r) => [r.rowId, r.oldId])],
    );
    if (Number(pending.rows[0]?.n ?? 0) > 0) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // Full pre-change snapshot (created only on the first run).
        await client.query(
          `CREATE TABLE IF NOT EXISTS workspace_members_backup_20260803 AS
             SELECT * FROM workspace_members`,
        );
        // Detach ahmad's empty solo-workspace membership to free his Clerk ID.
        const detached = await client.query(
          `UPDATE workspace_members
              SET member_user_id = NULL, joined_at = NULL
            WHERE id = $1 AND member_user_id = $2`,
          [AHMAD_SOLO_ROW_ID, AHMAD_NEW_ID],
        );
        let relinkCount = 0;
        for (const r of RELINKS) {
          const updated = await client.query(
            `UPDATE workspace_members SET member_user_id = $1
              WHERE id = $2 AND member_user_id = $3 AND member_email = $4`,
            [r.newId, r.rowId, r.oldId, r.email],
          );
          if (updated.rowCount) {
            relinkCount += updated.rowCount;
            logger.info(
              { rowId: r.rowId, email: r.email },
              'clerk-membership-reconciliation: relinked membership to current Clerk ID',
            );
          }
        }
        await client.query('COMMIT');
        logger.info(
          { relinked: relinkCount, soloDetached: detached.rowCount ?? 0 },
          'clerk-membership-reconciliation: applied (backup: workspace_members_backup_20260803)',
        );
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error({ err }, 'clerk-membership-reconciliation: transaction failed, rolled back');
      } finally {
        client.release();
      }
    } else {
      logger.info('clerk-membership-reconciliation: already applied — nothing to do');
    }
  }

  // ── suppliers.display_name column ────────────────────────────────────────────
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS display_name text;`);
  {
    const backfill = await db.query(`
      UPDATE suppliers SET display_name = name WHERE display_name IS NULL;
    `);
    if (backfill.rowCount && backfill.rowCount > 0) {
      logger.info(`suppliers.display_name: backfilled ${backfill.rowCount} row(s) from name`);
    } else {
      logger.info("suppliers.display_name: column ready (no backfill needed)");
    }
  }

  // ── Finance entities and AI invoice import tables ────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS finance_entities (
      id serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      legal_name text NOT NULL,
      display_name text,
      country text,
      tax_registration_number text,
      accounting_system text NOT NULL DEFAULT 'none',
      odoo_company_id integer,
      odoo_company_name text,
      odoo_database text,
      odoo_base_url text,
      odoo_integration_token text,
      default_currency text NOT NULL DEFAULT 'USD',
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_finance_entities_workspace ON finance_entities(workspace_owner_id);`);
  await db.query(`ALTER TABLE finance_entities ADD COLUMN IF NOT EXISTS odoo_default_expense_account_id integer;`);
  await db.query(`
    UPDATE finance_entities
       SET country = UPPER(TRIM(country)),
           updated_at = now()
     WHERE country IS NOT NULL
       AND country <> UPPER(TRIM(country))
  `);
  const duplicateActiveLebanonEntities = await db.query<{ workspace_owner_id: string; active_count: string }>(`
    SELECT workspace_owner_id, COUNT(*)::text AS active_count
      FROM finance_entities
     WHERE country = 'LB' AND is_active = true
     GROUP BY workspace_owner_id
    HAVING COUNT(*) > 1
  `);
  if (duplicateActiveLebanonEntities.rowCount && duplicateActiveLebanonEntities.rowCount > 0) {
    logger.warn(
      { duplicateWorkspaceCount: duplicateActiveLebanonEntities.rowCount },
      "finance_entities: deactivating surplus active Lebanon entities before enforcing uniqueness",
    );
    await db.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY workspace_owner_id
                 ORDER BY (
                   accounting_system = 'odoo'
                   AND odoo_base_url IS NOT NULL
                   AND odoo_database IS NOT NULL
                   AND odoo_company_id IS NOT NULL
                   AND odoo_company_name IS NOT NULL
                   AND odoo_integration_token IS NOT NULL
                 ) DESC,
                 updated_at DESC,
                 id DESC
               ) AS entity_rank
          FROM finance_entities
         WHERE country = 'LB' AND is_active = true
      )
      UPDATE finance_entities fe
         SET is_active = false,
             updated_at = now()
        FROM ranked r
       WHERE fe.id = r.id
         AND r.entity_rank > 1
    `);
  }
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS finance_entities_one_active_lb_per_workspace
      ON finance_entities(workspace_owner_id)
      WHERE country = 'LB' AND is_active = true
  `);
  logger.info("finance_entities table ready");

  // ── wafeq_connections — one encrypted workspace-level connection ───────────
  // The API key is encrypted by the caller before persistence. Never select,
  // log, or include encrypted_api_key in an API response.
  await db.query(`
    CREATE TABLE IF NOT EXISTS wafeq_connections (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      encrypted_api_key     text NOT NULL,
      organization_id       text,
      organization_name     text,
      status                text NOT NULL DEFAULT 'pending',
      last_verified_at      timestamptz,
      last_error            text,
      last_error_at         timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE wafeq_connections
      ADD COLUMN IF NOT EXISTS encrypted_api_key text,
      ADD COLUMN IF NOT EXISTS organization_id text,
      ADD COLUMN IF NOT EXISTS organization_name text,
      ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
      ADD COLUMN IF NOT EXISTS last_error text,
      ADD COLUMN IF NOT EXISTS last_error_at timestamptz,
      ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS wafeq_connections_workspace_owner_unique
      ON wafeq_connections(workspace_owner_id);
    CREATE INDEX IF NOT EXISTS idx_wafeq_connections_status
      ON wafeq_connections(status);
  `);
  logger.info("wafeq_connections table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_invoice_imports (
      id serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      entity_id integer NOT NULL REFERENCES finance_entities(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'uploaded',
      original_filename text,
      pdf_storage_path text,
      vendor_name text,
      vendor_tax_number text,
      vendor_address text,
      invoice_number text,
      invoice_date date,
      due_date date,
      currency text,
      subtotal numeric(20,4),
      tax_amount numeric(20,4),
      total_amount numeric(20,4),
      line_items jsonb NOT NULL DEFAULT '[]',
      confidence numeric(4,3),
      company_validation_status text,
      company_validation_notes text,
      raw_ai_json jsonb,
      odoo_bill_id text,
      odoo_bill_url text,
      manually_entered_by text,
      manually_entered_at timestamptz,
      manual_notes text,
      manual_accounting_reference text,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_invoice_imports_workspace ON ai_invoice_imports(workspace_owner_id, created_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_invoice_imports_entity ON ai_invoice_imports(entity_id);`);
  // Stable Wafeq selections and provider-neutral bill persistence. Odoo
  // columns remain separate and are intentionally not renamed or removed.
  await db.query(`
    ALTER TABLE ai_invoice_imports
      ADD COLUMN IF NOT EXISTS wafeq_supplier_id text,
      ADD COLUMN IF NOT EXISTS wafeq_account_id text,
      ADD COLUMN IF NOT EXISTS wafeq_tax_id text,
      ADD COLUMN IF NOT EXISTS provider_bill_id text,
      ADD COLUMN IF NOT EXISTS provider_bill_status text,
      ADD COLUMN IF NOT EXISTS provider_bill_url text,
      ADD COLUMN IF NOT EXISTS provider_sync_status text NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS provider_synced_at timestamptz,
      ADD COLUMN IF NOT EXISTS provider_sync_error text,
      ADD COLUMN IF NOT EXISTS provider_sync_idempotency_key text;
    CREATE INDEX IF NOT EXISTS idx_ai_invoice_imports_wafeq_supplier
      ON ai_invoice_imports(workspace_owner_id, wafeq_supplier_id);
    CREATE INDEX IF NOT EXISTS idx_ai_invoice_imports_provider_bill
      ON ai_invoice_imports(workspace_owner_id, provider_bill_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ai_invoice_imports_provider_sync_key_unique
      ON ai_invoice_imports(workspace_owner_id, provider_sync_idempotency_key)
      WHERE provider_sync_idempotency_key IS NOT NULL;
  `);
  logger.info("ai_invoice_imports table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_invoice_import_settings (
      id serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      entity_id integer NOT NULL REFERENCES finance_entities(id) ON DELETE CASCADE,
      settings_json jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_invoice_import_settings_entity_unique UNIQUE (workspace_owner_id, entity_id)
    );
  `);
  logger.info("ai_invoice_import_settings table ready");

  // ── suppliers profile columns (task #430) ────────────────────────────────────
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS is_reviewed boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS reviewed_at timestamptz`);
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS reviewed_by text`);
  logger.info("ai_invoice_imports review columns ready");

  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS supplier_code text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS currency_pref text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_days integer`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS min_order_value numeric`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS notes text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_by_clerk_id text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS created_by_clerk_id text`);
  logger.info("suppliers profile columns ready");

  // ── supplier_documents — file attachments for a supplier ────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_documents (
      id                    serial PRIMARY KEY,
      supplier_id           integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      workspace_owner_id    text NOT NULL,
      file_name             text NOT NULL,
      file_url              text NOT NULL,
      uploaded_by_clerk_id  text,
      created_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_docs_supplier ON supplier_documents(supplier_id);`);
  logger.info("supplier_documents table ready");

  // ── supplier_statements — monthly statement-of-account files ────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_statements (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      supplier_id           integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      workspace_owner_id    text NOT NULL,
      statement_month       integer NOT NULL,
      statement_year        integer NOT NULL,
      statement_date        date,
      currency              text,
      opening_balance       numeric(14,4),
      closing_balance       numeric(14,4),
      file_url              text NOT NULL,
      original_file_name    text NOT NULL,
      mime_type             text,
      file_size_bytes       integer,
      notes                 text,
      status                text NOT NULL DEFAULT 'uploaded',
      uploaded_by_member_id integer REFERENCES workspace_members(id) ON DELETE SET NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_statements_supplier ON supplier_statements(supplier_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_statements_workspace ON supplier_statements(workspace_owner_id);`);
  await db.query(`
    ALTER TABLE supplier_statements
      ADD COLUMN IF NOT EXISTS finance_entity_id integer REFERENCES finance_entities(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS period_start date,
      ADD COLUMN IF NOT EXISTS period_end date,
      ADD COLUMN IF NOT EXISTS period_label text,
      ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'manual_upload',
      ADD COLUMN IF NOT EXISTS collection_request_id uuid,
      ADD COLUMN IF NOT EXISTS received_at timestamptz,
      ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'unmatched';
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_statements_collection_request ON supplier_statements(collection_request_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_statements_exact_period ON supplier_statements(workspace_owner_id, supplier_id, finance_entity_id, period_start, period_end);`);
  logger.info("supplier_statements table ready");

  // ── supplier statement collection domain ────────────────────────────────────
  // These tables intentionally keep journey and recipient snapshots on each
  // request. Editing a schedule or contact must never rewrite an in-flight
  // request's historical communication plan.
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_statement_contacts (
      id                    serial PRIMARY KEY,
      workspace_owner_id   text NOT NULL,
      supplier_id          integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      name                 text NOT NULL,
      role                 text,
      department            text,
      email                text,
      phone                text,
      whatsapp_phone       text,
      provenance            text NOT NULL DEFAULT 'manual',
      source_reference      text,
      is_approved           boolean NOT NULL DEFAULT false,
      is_selected           boolean NOT NULL DEFAULT false,
      is_active             boolean NOT NULL DEFAULT true,
      approved_at           timestamptz,
      approved_by           text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT supplier_statement_contacts_email_unique
        UNIQUE (workspace_owner_id, supplier_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_contacts_workspace_supplier
      ON supplier_statement_contacts(workspace_owner_id, supplier_id);
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_contacts_active
      ON supplier_statement_contacts(workspace_owner_id, is_active);

    CREATE TABLE IF NOT EXISTS supplier_statement_journeys (
      id                    serial PRIMARY KEY,
      workspace_owner_id   text NOT NULL,
      supplier_id          integer REFERENCES suppliers(id) ON DELETE CASCADE,
      name                 text NOT NULL,
      description           text,
      is_active             boolean NOT NULL DEFAULT true,
      created_by            text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_journeys_workspace
      ON supplier_statement_journeys(workspace_owner_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_journeys_supplier
      ON supplier_statement_journeys(workspace_owner_id, supplier_id);

    CREATE TABLE IF NOT EXISTS supplier_statement_journey_versions (
      id                    serial PRIMARY KEY,
      journey_id            integer NOT NULL REFERENCES supplier_statement_journeys(id) ON DELETE CASCADE,
      workspace_owner_id   text NOT NULL,
      version               integer NOT NULL,
      steps                 jsonb NOT NULL DEFAULT '[]'::jsonb,
      recipients            jsonb NOT NULL DEFAULT '[]'::jsonb,
      escalation_settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by            text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT supplier_statement_journey_versions_unique UNIQUE (journey_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_journey_versions_workspace
      ON supplier_statement_journey_versions(workspace_owner_id, journey_id);

    CREATE TABLE IF NOT EXISTS supplier_statement_schedules (
      id                    serial PRIMARY KEY,
      workspace_owner_id   text NOT NULL,
      supplier_id          integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      finance_entity_id    integer NOT NULL REFERENCES finance_entities(id) ON DELETE CASCADE,
      cadence              text NOT NULL DEFAULT 'monthly',
      local_day            integer NOT NULL DEFAULT 1,
      local_time           time NOT NULL DEFAULT '09:00',
      timezone             text NOT NULL DEFAULT 'UTC',
      first_run_date       date NOT NULL,
      journey_id           integer REFERENCES supplier_statement_journeys(id) ON DELETE SET NULL,
      escalation_settings  jsonb NOT NULL DEFAULT '{}'::jsonb,
      is_active            boolean NOT NULL DEFAULT false,
      paused_at            timestamptz,
      paused_reason        text,
      last_run_at          timestamptz,
      next_run_at          timestamptz,
      created_by           text,
      updated_by           text,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT supplier_statement_schedules_supplier_entity_unique
        UNIQUE (workspace_owner_id, supplier_id, finance_entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_schedules_workspace
      ON supplier_statement_schedules(workspace_owner_id, is_active, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_schedules_supplier
      ON supplier_statement_schedules(workspace_owner_id, supplier_id);

    CREATE TABLE IF NOT EXISTS supplier_statement_requests (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id   text NOT NULL,
      supplier_id          integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      finance_entity_id    integer NOT NULL REFERENCES finance_entities(id) ON DELETE CASCADE,
      schedule_id           integer REFERENCES supplier_statement_schedules(id) ON DELETE SET NULL,
      period_start          date NOT NULL,
      period_end            date NOT NULL,
      period_label          text NOT NULL,
      cadence               text NOT NULL,
      timezone              text NOT NULL DEFAULT 'UTC',
      status                text NOT NULL DEFAULT 'open',
      source                text NOT NULL DEFAULT 'manual',
      next_action           text NOT NULL DEFAULT 'prepare',
      next_action_at        timestamptz,
      next_recurring_cycle_at timestamptz,
      journey_version_id    integer REFERENCES supplier_statement_journey_versions(id) ON DELETE SET NULL,
      journey_snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
      recipients_snapshot   jsonb NOT NULL DEFAULT '[]'::jsonb,
      idempotency_key       text,
      received_at           timestamptz,
      cancelled_at          timestamptz,
      cancelled_reason      text,
      created_by            text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT supplier_statement_requests_idempotency_unique
        UNIQUE (workspace_owner_id, idempotency_key)
    );
    ALTER TABLE supplier_statement_requests
      ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_requests_workspace
      ON supplier_statement_requests(workspace_owner_id, status, next_action_at);
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_requests_supplier
      ON supplier_statement_requests(workspace_owner_id, supplier_id, period_start);
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_requests_entity
      ON supplier_statement_requests(workspace_owner_id, finance_entity_id, period_start);
    CREATE UNIQUE INDEX IF NOT EXISTS supplier_statement_requests_open_period_unique
      ON supplier_statement_requests(workspace_owner_id, supplier_id, finance_entity_id, period_start, period_end)
      WHERE status NOT IN ('received', 'reconciled', 'cancelled');

    CREATE TABLE IF NOT EXISTS supplier_statement_step_executions (
      id                    serial PRIMARY KEY,
      request_id            uuid NOT NULL REFERENCES supplier_statement_requests(id) ON DELETE CASCADE,
      workspace_owner_id   text NOT NULL,
      step_order            integer NOT NULL,
      channel               text NOT NULL,
      delay_minutes         integer NOT NULL DEFAULT 0,
      scheduled_at          timestamptz,
      status                text NOT NULL DEFAULT 'pending',
      provider_message_id   text,
      completed_at          timestamptz,
      last_error             text,
      attempt_count         integer NOT NULL DEFAULT 0,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT supplier_statement_step_executions_request_step_unique
        UNIQUE (request_id, step_order)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_step_executions_due
      ON supplier_statement_step_executions(workspace_owner_id, status, scheduled_at);

    CREATE TABLE IF NOT EXISTS supplier_statement_communication_events (
      id                    serial PRIMARY KEY,
      request_id            uuid NOT NULL REFERENCES supplier_statement_requests(id) ON DELETE CASCADE,
      step_execution_id     integer REFERENCES supplier_statement_step_executions(id) ON DELETE SET NULL,
      workspace_owner_id   text NOT NULL,
      event_type            text NOT NULL,
      channel               text,
      provider_event_id     text,
      payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at           timestamptz NOT NULL DEFAULT now(),
      created_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT supplier_statement_communication_events_provider_unique
        UNIQUE (workspace_owner_id, provider_event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_communication_events_request
      ON supplier_statement_communication_events(request_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_communication_events_workspace
      ON supplier_statement_communication_events(workspace_owner_id, occurred_at);

    CREATE TABLE IF NOT EXISTS supplier_statement_inbound_messages (
      id                    serial PRIMARY KEY,
      request_id            uuid NOT NULL REFERENCES supplier_statement_requests(id) ON DELETE CASCADE,
      workspace_owner_id   text NOT NULL,
      channel               text NOT NULL,
      sender                text,
      body                  text,
      attachment_url        text,
      attachment_file_name  text,
      received_at           timestamptz NOT NULL DEFAULT now(),
      created_at            timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_inbound_messages_request
      ON supplier_statement_inbound_messages(request_id, received_at);
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_inbound_messages_workspace
      ON supplier_statement_inbound_messages(workspace_owner_id, received_at);

    CREATE TABLE IF NOT EXISTS supplier_statement_audit_events (
      id                    serial PRIMARY KEY,
      workspace_owner_id   text NOT NULL,
      entity_type           text NOT NULL,
      entity_id             text NOT NULL,
      action                text NOT NULL,
      actor_id              text,
      metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at            timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_audit_events_entity
      ON supplier_statement_audit_events(workspace_owner_id, entity_type, entity_id, created_at);
  `);
  // Delivery integrations keep provider state on the existing collection
  // rows. These additive columns preserve the domain API's snapshots while
  // making sends, callbacks, and inbound documents restart-safe.
  await db.query(`
    ALTER TABLE supplier_statement_step_executions
      ADD COLUMN IF NOT EXISTS supplier_id integer REFERENCES suppliers(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS supplier_contact_id integer REFERENCES supplier_statement_contacts(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS finance_entity_id integer REFERENCES finance_entities(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS period_start date,
      ADD COLUMN IF NOT EXISTS period_end date,
      ADD COLUMN IF NOT EXISTS destination text,
      ADD COLUMN IF NOT EXISTS provider_contact_id text,
      ADD COLUMN IF NOT EXISTS provider_conversation_id text,
      ADD COLUMN IF NOT EXISTS provider_channel_id text,
      ADD COLUMN IF NOT EXISTS template_name text,
      ADD COLUMN IF NOT EXISTS rendered_variables jsonb,
      ADD COLUMN IF NOT EXISTS idempotency_key text,
      ADD COLUMN IF NOT EXISTS planned_at timestamptz,
      ADD COLUMN IF NOT EXISTS sent_at timestamptz,
      ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
      ADD COLUMN IF NOT EXISTS read_at timestamptz,
      ADD COLUMN IF NOT EXISTS replied_at timestamptz,
      ADD COLUMN IF NOT EXISTS provider_status text,
      ADD COLUMN IF NOT EXISTS failure_code text,
      ADD COLUMN IF NOT EXISTS failure_details jsonb,
      ADD COLUMN IF NOT EXISTS reply_to text,
      ADD COLUMN IF NOT EXISTS correlation_id text;
    CREATE UNIQUE INDEX IF NOT EXISTS supplier_statement_step_idempotency_unique
      ON supplier_statement_step_executions(workspace_owner_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_supplier_statement_step_provider_message
      ON supplier_statement_step_executions(provider_message_id)
      WHERE provider_message_id IS NOT NULL;

    ALTER TABLE supplier_statement_inbound_messages
      ADD COLUMN IF NOT EXISTS provider_event_id text,
      ADD COLUMN IF NOT EXISTS provider_message_id text,
      ADD COLUMN IF NOT EXISTS provider_contact_id text,
      ADD COLUMN IF NOT EXISTS provider_conversation_id text,
      ADD COLUMN IF NOT EXISTS provider_channel_id text,
      ADD COLUMN IF NOT EXISTS in_reply_to_provider_message_id text,
      ADD COLUMN IF NOT EXISTS sender_phone text,
      ADD COLUMN IF NOT EXISTS subject text,
      ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS classification text NOT NULL DEFAULT 'reply',
      ADD COLUMN IF NOT EXISTS document_status text;
    CREATE UNIQUE INDEX IF NOT EXISTS supplier_statement_inbound_provider_message_unique
      ON supplier_statement_inbound_messages(workspace_owner_id, provider_message_id)
      WHERE provider_message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS supplier_statement_inbound_provider_event_unique
      ON supplier_statement_inbound_messages(workspace_owner_id, provider_event_id)
      WHERE provider_event_id IS NOT NULL;
  `);
  await db.query(`
    UPDATE supplier_statements
       SET period_start = make_date(statement_year, statement_month, 1),
           period_end = (make_date(statement_year, statement_month, 1) + interval '1 month - 1 day')::date,
           period_label = to_char(make_date(statement_year, statement_month, 1), 'FMMonth YYYY')
     WHERE period_start IS NULL
       AND statement_year BETWEEN 1900 AND 9999
       AND statement_month BETWEEN 1 AND 12
  `);
  logger.info("supplier statement collection tables ready");

  // ── purchase_orders ──────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id                      serial PRIMARY KEY,
      workspace_owner_id      text NOT NULL,
      supplier_id             integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      po_number               text,
      status                  text NOT NULL DEFAULT 'draft',
      currency                text NOT NULL DEFAULT 'AED',
      total_amount            numeric(14,4),
      expected_delivery_date  timestamptz,
      notes                   text,
      created_by_clerk_id     text,
      updated_by_clerk_id     text,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now(),
      sent_at                 timestamptz
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_workspace ON purchase_orders(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS total_amount_manual_override boolean NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS location_id integer REFERENCES locations(id) ON DELETE SET NULL;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_location ON purchase_orders(location_id);`);
  // Backfill the FK column on base_item_stock_adjustments that was skipped
  // earlier in the init sequence when purchase_orders didn't exist yet.
  await db.query(`
    ALTER TABLE base_item_stock_adjustments
      ADD COLUMN IF NOT EXISTS purchase_order_id integer
        REFERENCES purchase_orders(id) ON DELETE SET NULL;
  `);
  logger.info("purchase_orders table ready");

  // ── purchase_order_line_items ────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_order_line_items (
      id                      serial PRIMARY KEY,
      purchase_order_id       integer NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      base_item_id            integer,
      supplier_catalog_item_id integer,
      base_item_supplier_id   integer REFERENCES base_item_suppliers(id) ON DELETE SET NULL,
      description             text NOT NULL,
      quantity                numeric(14,4) NOT NULL DEFAULT 1,
      unit_price              numeric(14,4) NOT NULL DEFAULT 0,
      currency                text NOT NULL DEFAULT 'AED',
      received_quantity       numeric(14,4),
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    ALTER TABLE purchase_order_line_items
      ADD COLUMN IF NOT EXISTS supplier_catalog_item_id integer;
  `);
  await db.query(`
    ALTER TABLE purchase_order_line_items
      ADD COLUMN IF NOT EXISTS description_ar text;
  `);
  logger.info("purchase_order_line_items table ready");

  // ── supplier_invoices — per-supplier invoice ledger ─────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id                  serial PRIMARY KEY,
      supplier_id         integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      workspace_owner_id  text NOT NULL,
      amount              numeric(14,4) NOT NULL,
      currency            text NOT NULL DEFAULT 'AED',
      status              text NOT NULL DEFAULT 'issued',
      invoice_number      text,
      issued_at           timestamptz NOT NULL DEFAULT now(),
      paid_at             timestamptz,
      notes               text,
      reference_type      text,
      reference_id        integer,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices(supplier_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoices_workspace ON supplier_invoices(workspace_owner_id, issued_at DESC);`);
  logger.info("supplier_invoices table ready");

  // ── ai_invoice_imports processing_step column (task #449) ───────────────────
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS processing_step text NOT NULL DEFAULT 'queued'`);
  logger.info("ai_invoice_imports processing_step column ready");

  // ── ai_invoice_imports supplier_id FK (task #3949) ──────────────────────────
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS supplier_id integer REFERENCES suppliers(id) ON DELETE SET NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_invoice_imports_supplier ON ai_invoice_imports(supplier_id)`);
  logger.info("ai_invoice_imports supplier_id column ready");

  // ── ai_invoice_imports billing_country — AI-detected country of the invoice ──
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS billing_country text`);
  logger.info("ai_invoice_imports billing_country column ready");

  // ── Invoice review workflow (task #4959) ───────────────────────────────────
  // Keep these additive. The review workspace is now the standard invoice flow;
  // the legacy flag remains only for backward-compatible API responses.
  await db.query(`
    ALTER TABLE finance_entities ADD COLUMN IF NOT EXISTS invoice_review_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE finance_entities ALTER COLUMN invoice_review_enabled SET DEFAULT true;
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'needs_review';
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'not_requested';
     ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS accounting_destination text;
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS review_version integer NOT NULL DEFAULT 1;
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS approved_at timestamptz;
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS approved_by text;
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS rejected_by text;
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS rejection_reason text;
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS reviewed_snapshot jsonb;
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS extraction_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
     ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS supplier_confirmation jsonb;
     ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS source_batch_id text;
     ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS source_page_number integer;
     ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS source_page_count integer;
     ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS superseded_by_import_id integer REFERENCES ai_invoice_imports(id) ON DELETE SET NULL;
     ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
     ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS supersede_reason text;
    UPDATE ai_invoice_imports
       SET review_status = CASE WHEN is_reviewed THEN 'approved' WHEN status = 'failed' THEN 'needs_review' ELSE 'needs_review' END,
           sync_status = CASE WHEN status = 'sent_to_odoo' THEN 'succeeded' WHEN status = 'processing' THEN 'in_progress' WHEN status = 'failed' THEN 'failed' ELSE 'not_requested' END
     WHERE review_status = 'needs_review' AND sync_status = 'not_requested';
    CREATE INDEX IF NOT EXISTS idx_ai_invoice_imports_review_queue ON ai_invoice_imports(entity_id, review_status, created_at DESC);
    CREATE TABLE IF NOT EXISTS ai_invoice_import_issues (
      id serial PRIMARY KEY, import_id integer NOT NULL REFERENCES ai_invoice_imports(id) ON DELETE CASCADE,
      issue_key text NOT NULL, severity text NOT NULL, message text NOT NULL, field text, blocking boolean NOT NULL DEFAULT false,
      resolved_at timestamptz, resolved_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(import_id, issue_key)
    );
    CREATE TABLE IF NOT EXISTS ai_invoice_import_acknowledgements (
      id serial PRIMARY KEY, import_id integer NOT NULL REFERENCES ai_invoice_imports(id) ON DELETE CASCADE,
      issue_key text NOT NULL, version integer NOT NULL, acknowledged_by text NOT NULL, acknowledged_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(import_id, issue_key, version)
    );
    CREATE TABLE IF NOT EXISTS ai_invoice_import_sync_attempts (
      id serial PRIMARY KEY, import_id integer NOT NULL REFERENCES ai_invoice_imports(id) ON DELETE CASCADE,
      idempotency_key text NOT NULL, review_version integer NOT NULL, status text NOT NULL DEFAULT 'pending', destination text,
      external_reference text, error text, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      UNIQUE(import_id, idempotency_key)
    );
    ALTER TABLE ai_invoice_import_sync_attempts ADD COLUMN IF NOT EXISTS lease_token text;
    ALTER TABLE ai_invoice_import_sync_attempts ADD COLUMN IF NOT EXISTS lease_until timestamptz;
    ALTER TABLE ai_invoice_import_sync_attempts ADD COLUMN IF NOT EXISTS verified_at timestamptz;
    CREATE INDEX IF NOT EXISTS idx_ai_invoice_import_sync_attempts_import
      ON ai_invoice_import_sync_attempts(import_id, started_at);
    CREATE TABLE IF NOT EXISTS ai_invoice_import_audit_events (
      id serial PRIMARY KEY, import_id integer NOT NULL REFERENCES ai_invoice_imports(id) ON DELETE CASCADE,
      actor_id text, event_type text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_invoice_import_issues_import ON ai_invoice_import_issues(import_id, blocking);
    CREATE INDEX IF NOT EXISTS idx_ai_invoice_import_audit_import ON ai_invoice_import_audit_events(import_id, created_at DESC);
     CREATE INDEX IF NOT EXISTS idx_ai_invoice_imports_source_batch
       ON ai_invoice_imports(workspace_owner_id, source_batch_id, source_page_number);
  `);
  logger.info("invoice review workflow tables ready");

  // ── ai_invoice_import_edits (task #451) ─────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_invoice_import_edits (
      id serial PRIMARY KEY,
      import_id integer NOT NULL REFERENCES ai_invoice_imports(id) ON DELETE CASCADE,
      changed_by text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now(),
      before_values jsonb NOT NULL,
      after_values jsonb NOT NULL
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_invoice_edits_import ON ai_invoice_import_edits(import_id, changed_at DESC);`);
  logger.info("ai_invoice_import_edits table ready");

  // ── delivery_cities pricing columns (task #476) ──────────────────────────────
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS delivery_fee numeric(10,2) NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS free_delivery_enabled boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS free_delivery_threshold numeric(10,2)`);
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS express_delivery_enabled boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS express_delivery_fee numeric(10,2)`);
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS express_delivery_cutoff_time text`);
  logger.info("delivery_cities pricing columns ready");

  // ── workspace_settings delivery webhook URL (task #476) ──────────────────────
  await db.query(`ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS delivery_webhook_url text`);
  logger.info("workspace_settings.delivery_webhook_url column ready");

  // ── workspace_settings Trustpilot invitations toggle ─────────────────────────
  // Per-workspace on/off switch for Trustpilot service-review invitations.
  // Defaults ON; the TRUSTPILOT_ENABLED env flag remains the master switch.
  await db.query(`ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS trustpilot_invitations_enabled boolean NOT NULL DEFAULT true`);
  logger.info("workspace_settings.trustpilot_invitations_enabled column ready");

  // ── trustpilot_invitations — service-review invitation queue ─────────────────
  // Exactly one row per order (UNIQUE order_id → idempotent enqueue). Rows are
  // inserted when an order transitions to `completed` and processed
  // asynchronously with backoff retries.
  await db.query(`
    CREATE TABLE IF NOT EXISTS trustpilot_invitations (
      id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id                  uuid NOT NULL UNIQUE,
      workspace_owner_id        text NOT NULL,
      status                    text NOT NULL DEFAULT 'pending',
      recipient_email           text,
      recipient_name            text,
      reference_id              text,
      locale                    text,
      preferred_send_time       timestamptz,
      attempt_count             integer NOT NULL DEFAULT 0,
      next_attempt_at           timestamptz NOT NULL DEFAULT now(),
      last_error                text,
      last_attempt_at           timestamptz,
      trustpilot_invitation_id  text,
      response_payload          jsonb,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`ALTER TABLE trustpilot_invitations ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_trustpilot_invitations_due
      ON trustpilot_invitations(status, next_attempt_at);
  `);
  logger.info("trustpilot_invitations table ready");

  // ── workspace_settings workspace_slug — for public API slug resolution ───────
  await db.query(`ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS workspace_slug text`);
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workspace_settings_workspace_slug_unique'
      ) THEN
        ALTER TABLE workspace_settings ADD CONSTRAINT workspace_settings_workspace_slug_unique UNIQUE (workspace_slug);
      END IF;
    END $$
  `);
  logger.info("workspace_settings.workspace_slug column ready");

  // Set workspace_slug for the Presentail workspace if not already set.
  await db.query(`
    UPDATE workspace_settings
       SET workspace_slug = 'presentail'
     WHERE workspace_owner_id = 'user_3DCcbYtdoRYrTOqHwKxb1gwXxJR'
       AND (workspace_slug IS NULL OR workspace_slug = '');
  `);
  logger.info("workspace_settings workspace_slug presentail seed applied");

  // ── Catalog Attributes (Task #541) ────────────────────────────────────────
  // Four attribute tables for merchandising: occasions, catalog_categories,
  // catalog_brands, recipients. Each has city availability and product joins.

  await db.query(`
    CREATE TABLE IF NOT EXISTS occasions (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      slug                text NOT NULL,
      description         text,
      image_url           text,
      sort_order          integer NOT NULL DEFAULT 0,
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT occasions_workspace_slug_unique UNIQUE (workspace_owner_id, slug)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_occasions_workspace ON occasions(workspace_owner_id);`);
  // is_featured added later (catalogAttributes schema); idempotent backfill for
  // pre-existing occasions tables created before the column existed.
  await db.query(`ALTER TABLE occasions ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false;`);
  // image_public_path: stable key (relative to PUBLIC_OBJECT_SEARCH_PATHS) of the
  // public, auth-free copy of the occasion image. Populated on create/update and
  // by the startup backfill in backfillOccasionPublicImages().
  await db.query(`ALTER TABLE occasions ADD COLUMN IF NOT EXISTS image_public_path text;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS catalog_categories (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      slug                text NOT NULL,
      description         text,
      image_url           text,
      sort_order          integer NOT NULL DEFAULT 0,
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT catalog_categories_workspace_slug_unique UNIQUE (workspace_owner_id, slug)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_catalog_categories_workspace ON catalog_categories(workspace_owner_id);`);
  // image_public_path: stable key of the public, auth-free copy of the image.
  await db.query(`ALTER TABLE catalog_categories ADD COLUMN IF NOT EXISTS image_public_path text;`);
  // is_featured: when true the category appears in the public mega menu (mirrors occasions).
  await db.query(`ALTER TABLE catalog_categories ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false;`);
  // is_upsell: when true the category defines an upsell section on the website.
  await db.query(`ALTER TABLE catalog_categories ADD COLUMN IF NOT EXISTS is_upsell boolean NOT NULL DEFAULT false;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS catalog_brands (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      slug                text NOT NULL,
      description         text,
      image_url           text,
      sort_order          integer NOT NULL DEFAULT 0,
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT catalog_brands_workspace_slug_unique UNIQUE (workspace_owner_id, slug)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_catalog_brands_workspace ON catalog_brands(workspace_owner_id);`);
  // image_public_path: stable key of the public, auth-free copy of the image.
  await db.query(`ALTER TABLE catalog_brands ADD COLUMN IF NOT EXISTS image_public_path text;`);
  // banner_image_url: private GCS path of the hero banner image.
  await db.query(`ALTER TABLE catalog_brands ADD COLUMN IF NOT EXISTS banner_image_url text;`);
  // banner_public_path: stable key of the public, auth-free copy of the banner.
  await db.query(`ALTER TABLE catalog_brands ADD COLUMN IF NOT EXISTS banner_public_path text;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recipients (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      slug                text NOT NULL,
      description         text,
      image_url           text,
      sort_order          integer NOT NULL DEFAULT 0,
      is_active           boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT recipients_workspace_slug_unique UNIQUE (workspace_owner_id, slug)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_recipients_workspace ON recipients(workspace_owner_id);`);
  // image_public_path: stable key of the public, auth-free copy of the image.
  await db.query(`ALTER TABLE recipients ADD COLUMN IF NOT EXISTS image_public_path text;`);

  // ── City availability join tables ─────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS occasion_city_availability (
      id          serial PRIMARY KEY,
      occasion_id integer NOT NULL REFERENCES occasions(id) ON DELETE CASCADE,
      city_id     integer NOT NULL REFERENCES delivery_cities(id) ON DELETE CASCADE,
      is_enabled  boolean NOT NULL DEFAULT true,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT occasion_city_availability_unique UNIQUE (occasion_id, city_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_occasion_city_avail_city ON occasion_city_availability(city_id);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS catalog_category_city_availability (
      id                  serial PRIMARY KEY,
      catalog_category_id integer NOT NULL REFERENCES catalog_categories(id) ON DELETE CASCADE,
      city_id             integer NOT NULL REFERENCES delivery_cities(id) ON DELETE CASCADE,
      is_enabled          boolean NOT NULL DEFAULT true,
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT catalog_category_city_avail_unique UNIQUE (catalog_category_id, city_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cat_category_city_avail_city ON catalog_category_city_availability(city_id);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS catalog_brand_city_availability (
      id               serial PRIMARY KEY,
      catalog_brand_id integer NOT NULL REFERENCES catalog_brands(id) ON DELETE CASCADE,
      city_id          integer NOT NULL REFERENCES delivery_cities(id) ON DELETE CASCADE,
      is_enabled       boolean NOT NULL DEFAULT true,
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT catalog_brand_city_avail_unique UNIQUE (catalog_brand_id, city_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_catalog_brand_city_avail_city ON catalog_brand_city_availability(city_id);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS recipient_city_availability (
      id           serial PRIMARY KEY,
      recipient_id integer NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
      city_id      integer NOT NULL REFERENCES delivery_cities(id) ON DELETE CASCADE,
      is_enabled   boolean NOT NULL DEFAULT true,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT recipient_city_availability_unique UNIQUE (recipient_id, city_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_recipient_city_avail_city ON recipient_city_availability(city_id);`);

  // ── Product assignment join tables ────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS product_occasions (
      product_id   integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      attribute_id integer NOT NULL REFERENCES occasions(id) ON DELETE CASCADE,
      PRIMARY KEY (product_id, attribute_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_product_occasions_attr ON product_occasions(attribute_id);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS product_catalog_categories (
      product_id   integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      attribute_id integer NOT NULL REFERENCES catalog_categories(id) ON DELETE CASCADE,
      PRIMARY KEY (product_id, attribute_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_product_catalog_categories_attr ON product_catalog_categories(attribute_id);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS product_catalog_brands (
      product_id   integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      attribute_id integer NOT NULL REFERENCES catalog_brands(id) ON DELETE CASCADE,
      PRIMARY KEY (product_id, attribute_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_product_catalog_brands_attr ON product_catalog_brands(attribute_id);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS product_recipients (
      product_id   integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      attribute_id integer NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
      PRIMARY KEY (product_id, attribute_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_product_recipients_attr ON product_recipients(attribute_id);`);

  logger.info("catalog attribute tables ready");

  // ── Catalog attribute seed data ───────────────────────────────────────────
  // Only seeds for workspaces that have no data yet (empty tables).
  {
    const allWorkspaces = await db.query<{ workspace_owner_id: string }>(
      `SELECT DISTINCT workspace_owner_id FROM workspace_members WHERE role = 'owner'`,
    );
    for (const { workspace_owner_id } of allWorkspaces.rows) {
      const occasionCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM occasions WHERE workspace_owner_id = $1`,
        [workspace_owner_id],
      );
      if (parseInt(occasionCount.rows[0]?.count ?? "0", 10) === 0) {
        await db.query(`
          INSERT INTO occasions (workspace_owner_id, name, slug, sort_order)
          VALUES
            ($1, 'Birthday',     'birthday',     1),
            ($1, 'Anniversary',  'anniversary',  2),
            ($1, 'Wedding',      'wedding',      3),
            ($1, 'Graduation',   'graduation',   4),
            ($1, 'Thank You',    'thank-you',    5)
          ON CONFLICT (workspace_owner_id, slug) DO NOTHING
        `, [workspace_owner_id]);
      }

      const categoryCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM catalog_categories WHERE workspace_owner_id = $1`,
        [workspace_owner_id],
      );
      if (parseInt(categoryCount.rows[0]?.count ?? "0", 10) === 0) {
        await db.query(`
          INSERT INTO catalog_categories (workspace_owner_id, name, slug, sort_order)
          VALUES
            ($1, 'Flowers',        'flowers',        1),
            ($1, 'Chocolates',     'chocolates',     2),
            ($1, 'Gift Baskets',   'gift-baskets',   3),
            ($1, 'Personalized',   'personalized',   4),
            ($1, 'Luxury',         'luxury',         5)
          ON CONFLICT (workspace_owner_id, slug) DO NOTHING
        `, [workspace_owner_id]);
      }

      const brandCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM catalog_brands WHERE workspace_owner_id = $1`,
        [workspace_owner_id],
      );
      if (parseInt(brandCount.rows[0]?.count ?? "0", 10) === 0) {
        await db.query(`
          INSERT INTO catalog_brands (workspace_owner_id, name, slug, sort_order)
          VALUES
            ($1, 'Local Artisan',   'local-artisan',  1),
            ($1, 'Premium',         'premium',        2),
            ($1, 'Eco-Friendly',    'eco-friendly',   3),
            ($1, 'Handmade',        'handmade',       4)
          ON CONFLICT (workspace_owner_id, slug) DO NOTHING
        `, [workspace_owner_id]);
      }

      const recipientCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM recipients WHERE workspace_owner_id = $1`,
        [workspace_owner_id],
      );
      if (parseInt(recipientCount.rows[0]?.count ?? "0", 10) === 0) {
        await db.query(`
          INSERT INTO recipients (workspace_owner_id, name, slug, sort_order)
          VALUES
            ($1, 'Mom',       'mom',        1),
            ($1, 'Dad',       'dad',        2),
            ($1, 'Partner',   'partner',    3),
            ($1, 'Friend',    'friend',     4),
            ($1, 'Colleague', 'colleague',  5),
            ($1, 'Kids',      'kids',       6)
          ON CONFLICT (workspace_owner_id, slug) DO NOTHING
        `, [workspace_owner_id]);
      }
    }
    logger.info("catalog attribute seed data applied");
  }

  // ── Outgoing webhook endpoints ────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id                   serial PRIMARY KEY,
      workspace_owner_id   text NOT NULL,
      name                 text NOT NULL,
      endpoint_url         text NOT NULL,
      subscribed_events    jsonb NOT NULL DEFAULT '[]',
      signing_secret       text NOT NULL,
      is_active            boolean NOT NULL DEFAULT true,
      last_delivery_status text,
      last_delivery_at     timestamptz,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'webhook_endpoints'
            AND indexname  = 'idx_webhook_endpoints_owner'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_owner ON webhook_endpoints(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_webhook_endpoints_owner: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_webhook_endpoints_owner: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("webhook_endpoints table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id                   serial PRIMARY KEY,
      webhook_endpoint_id  integer NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event                text NOT NULL,
      payload              jsonb NOT NULL,
      status               text NOT NULL DEFAULT 'pending',
      response_status      integer,
      response_body        text,
      attempt_count        integer NOT NULL DEFAULT 0,
      next_retry_at        timestamptz,
      created_at           timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'webhook_deliveries'
            AND indexname  = 'idx_webhook_deliveries_endpoint'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(webhook_endpoint_id, created_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_webhook_deliveries_endpoint: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_webhook_deliveries_endpoint: was missing — created successfully (deployment migrated)");
    }
  }
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'webhook_deliveries'
            AND indexname  = 'idx_webhook_deliveries_retry'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at) WHERE status = 'pending_retry';`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_webhook_deliveries_retry: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_webhook_deliveries_retry: was missing — created successfully (deployment migrated)");
    }
  }
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retention
       ON webhook_deliveries(created_at)
       WHERE status IN ('delivered', 'failed');`,
  );
  logger.info("webhook_deliveries table ready");

  // Security alert events — records each alert email dispatched to a user.
  await db.query(`
    CREATE TABLE IF NOT EXISTS security_alert_events (
      id           serial PRIMARY KEY,
      user_id      text NOT NULL,
      kind         text NOT NULL,
      device_label text,
      country      text,
      sent_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'security_alert_events'
            AND indexname  = 'idx_sec_alert_events_user'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_sec_alert_events_user ON security_alert_events(user_id, sent_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_sec_alert_events_user: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_sec_alert_events_user: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("security_alert_events table ready");

  // ── Delivery Scheduling Engine (Task #652) ───────────────────────────────────
  // Four new tables that extend the `cities` table with district-level
  // scheduling: extended express settings, weekly day-of-week slots,
  // special date overrides, and slots for those overrides.

  // district_delivery_settings — one row per city, extends express delivery
  // with start/end time, minimum prep, and daily capacity.
  await db.query(`
    CREATE TABLE IF NOT EXISTS district_delivery_settings (
      city_id                   integer PRIMARY KEY REFERENCES delivery_cities(id) ON DELETE CASCADE,
      workspace_owner_id        text NOT NULL,
      express_start_time        text,
      express_end_time          text,
      express_min_prep_minutes  integer,
      express_daily_capacity    integer,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_dds_owner ON district_delivery_settings(workspace_owner_id);`,
  );
  // Add extended express columns if they don't exist yet (idempotent migration).
  await db.query(`ALTER TABLE district_delivery_settings ADD COLUMN IF NOT EXISTS express_enabled boolean NOT NULL DEFAULT true;`);
  await db.query(`ALTER TABLE district_delivery_settings ADD COLUMN IF NOT EXISTS express_fee numeric(10,2);`);
  await db.query(`ALTER TABLE district_delivery_settings ADD COLUMN IF NOT EXISTS express_cutoff_time text;`);
  // Persistent "already seeded" marker so the startup weekly-slot seed runs
  // exactly once per city and can never re-introduce defaults for a city that
  // has already been configured (or intentionally emptied) by an owner.
  await db.query(`ALTER TABLE district_delivery_settings ADD COLUMN IF NOT EXISTS weekly_slots_seeded boolean NOT NULL DEFAULT false;`);
  logger.info("district_delivery_settings table ready");

  // district_weekly_delivery_slots — per-day-of-week slots for each city.
  // day_of_week: 0 = Sunday, 1 = Monday, …, 6 = Saturday.
  await db.query(`
    CREATE TABLE IF NOT EXISTS district_weekly_delivery_slots (
      id                serial PRIMARY KEY,
      city_id           integer NOT NULL REFERENCES delivery_cities(id) ON DELETE CASCADE,
      workspace_owner_id text NOT NULL,
      day_of_week       integer NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      label             text NOT NULL DEFAULT '',
      start_time        text NOT NULL,
      end_time          text NOT NULL,
      is_enabled        boolean NOT NULL DEFAULT true,
      fee_override      numeric(10,2),
      cutoff_time       text,
      capacity          integer,
      internal_note     text,
      sort_order        integer NOT NULL DEFAULT 0,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_dwds_city_day ON district_weekly_delivery_slots(city_id, day_of_week);`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_dwds_owner ON district_weekly_delivery_slots(workspace_owner_id);`,
  );
  // Install the identity guard before any startup seed can write. This also
  // closes the first-deployment race between seeding and API traffic.
  await db.query(`ALTER TABLE district_weekly_delivery_slots ADD COLUMN IF NOT EXISTS delivery_type text NOT NULL DEFAULT 'standard'`);
  await db.query(`ALTER TABLE district_weekly_delivery_slots ADD COLUMN IF NOT EXISTS same_day_available boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE district_weekly_delivery_slots ADD COLUMN IF NOT EXISTS next_day_available boolean NOT NULL DEFAULT true`);
  await db.query(`
    CREATE OR REPLACE FUNCTION enforce_district_weekly_delivery_slot_identity()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      excluded_id integer := -1;
      identity_changed boolean := true;
    BEGIN
      -- The reviewed rollback tool is the only caller that sets this
      -- transaction-local flag. It permits exact restoration of quarantined
      -- legacy duplicates while the containment trigger is still installed.
      IF current_setting('app.weekly_slot_cleanup_restore', true) = 'on' THEN
        RETURN NEW;
      END IF;

      NEW.delivery_type := lower(btrim(COALESCE(NEW.delivery_type, 'standard')));
      NEW.start_time := lpad(NEW.start_time, 5, '0');
      NEW.end_time := lpad(NEW.end_time, 5, '0');

      IF TG_OP = 'UPDATE' THEN
        excluded_id := OLD.id;
        identity_changed :=
          OLD.city_id IS DISTINCT FROM NEW.city_id
          OR OLD.day_of_week IS DISTINCT FROM NEW.day_of_week
          OR lower(btrim(OLD.delivery_type)) IS DISTINCT FROM NEW.delivery_type
          OR lpad(OLD.start_time, 5, '0') IS DISTINCT FROM NEW.start_time
          OR lpad(OLD.end_time, 5, '0') IS DISTINCT FROM NEW.end_time;
      END IF;

      -- Existing duplicate rows must remain editable when only an attribute
      -- changes so managers can disable or annotate them before cleanup.
      IF NOT identity_changed THEN
        RETURN NEW;
      END IF;

      PERFORM pg_advisory_xact_lock(
        hashtextextended(format('district-weekly-slots:%s', NEW.city_id), 0)
      );

      IF EXISTS (
        SELECT 1
          FROM district_weekly_delivery_slots s
         WHERE s.city_id = NEW.city_id
           AND s.day_of_week = NEW.day_of_week
           AND lower(btrim(s.delivery_type)) = NEW.delivery_type
           AND lpad(s.start_time, 5, '0') = NEW.start_time
           AND lpad(s.end_time, 5, '0') = NEW.end_time
           AND s.id <> excluded_id
      ) THEN
        RAISE EXCEPTION
          USING ERRCODE = '23505',
                CONSTRAINT = 'uq_dwds_natural_key',
                MESSAGE = 'A weekly delivery slot with this city, day, type, and time already exists';
      END IF;

      RETURN NEW;
    END;
    $$;
  `);
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_class index_class
          JOIN pg_index i ON i.indexrelid = index_class.oid
          JOIN pg_class table_class ON table_class.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = index_class.relnamespace
         WHERE n.nspname = 'public'
           AND index_class.relname = 'uq_dwds_natural_key'
           AND table_class.relname = 'district_weekly_delivery_slots'
           AND i.indisvalid
           AND i.indisready
           AND i.indisunique
           AND pg_get_indexdef(index_class.oid, 1, true) = 'city_id'
           AND pg_get_indexdef(index_class.oid, 2, true) = 'day_of_week'
           AND regexp_replace(pg_get_indexdef(index_class.oid, 3, true), '\\s|::text', '', 'g')
               = 'lower(btrim(delivery_type))'
           AND regexp_replace(pg_get_indexdef(index_class.oid, 4, true), '\\s|::text', '', 'g')
               = 'lpad(start_time,5,''0'')'
           AND regexp_replace(pg_get_indexdef(index_class.oid, 5, true), '\\s|::text', '', 'g')
               = 'lpad(end_time,5,''0'')'
      ) AND NOT EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgname = 'trg_dwds_slot_identity'
           AND tgrelid = 'district_weekly_delivery_slots'::regclass
      ) THEN
        CREATE TRIGGER trg_dwds_slot_identity
          BEFORE INSERT OR UPDATE ON district_weekly_delivery_slots
          FOR EACH ROW
          EXECUTE FUNCTION enforce_district_weekly_delivery_slot_identity();
      END IF;
    END
    $$;
  `);
  logger.info("district_weekly_delivery_slots table ready");

  // Reviewed weekly-slot cleanup is deliberately separate from containment.
  // The quarantine keeps original IDs and every column so an approved batch
  // can be restored without relying on an application-level reconstruction.
  await db.query(`
    CREATE TABLE IF NOT EXISTS weekly_slot_cleanup_batches (
      batch_id             text PRIMARY KEY,
      workspace_owner_id   text NOT NULL,
      export_sha256        text NOT NULL,
      exported_row_count   integer NOT NULL CHECK (exported_row_count > 0),
      affected_city_ids    integer[] NOT NULL,
      status               text NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running', 'completed', 'rolled_back')),
      before_snapshot      jsonb,
      after_snapshot       jsonb,
      created_at           timestamptz NOT NULL DEFAULT now(),
      completed_at         timestamptz,
      rolled_back_at       timestamptz
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS weekly_slot_cleanup_quarantine (
      batch_id             text NOT NULL REFERENCES weekly_slot_cleanup_batches(batch_id),
      original_id          integer NOT NULL,
      proposed_survivor_id integer NOT NULL,
      city_id              integer NOT NULL,
      workspace_owner_id   text NOT NULL,
      day_of_week          integer NOT NULL,
      label                text NOT NULL,
      start_time           text NOT NULL,
      end_time             text NOT NULL,
      is_enabled           boolean NOT NULL,
      fee_override         numeric(10,2),
      cutoff_time          text,
      capacity             integer,
      internal_note        text,
      sort_order           integer NOT NULL,
      delivery_type        text NOT NULL DEFAULT 'standard',
      same_day_available   boolean NOT NULL DEFAULT false,
      next_day_available   boolean NOT NULL DEFAULT true,
      created_at           timestamptz NOT NULL,
      updated_at           timestamptz NOT NULL,
      original_row         jsonb NOT NULL,
      quarantined_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (batch_id, original_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_weekly_slot_cleanup_quarantine_batch
      ON weekly_slot_cleanup_quarantine(batch_id, city_id);
  `);
  logger.info("weekly slot cleanup quarantine tables ready");

  // district_special_date_overrides — named date/range overrides that replace
  // or augment the regular weekly schedule for a city/country.
  await db.query(`
    CREATE TABLE IF NOT EXISTS district_special_date_overrides (
      id                        serial PRIMARY KEY,
      workspace_owner_id        text NOT NULL,
      city_id                   integer REFERENCES delivery_cities(id) ON DELETE CASCADE,
      country_code              text,
      name                      text NOT NULL,
      start_date                date NOT NULL,
      end_date                  date NOT NULL,
      override_type             text NOT NULL DEFAULT 'replace_regular_schedule',
      express_enabled           boolean NOT NULL DEFAULT false,
      express_start_time        text,
      express_end_time          text,
      express_cutoff_time       text,
      express_fee               numeric(10,2),
      express_min_prep_minutes  integer,
      express_daily_capacity    integer,
      internal_note             text,
      is_active                 boolean NOT NULL DEFAULT true,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_dsdo_owner ON district_special_date_overrides(workspace_owner_id);`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_dsdo_city ON district_special_date_overrides(city_id) WHERE city_id IS NOT NULL;`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_dsdo_dates ON district_special_date_overrides(workspace_owner_id, start_date, end_date);`,
  );
  logger.info("district_special_date_overrides table ready");

  // district_special_date_override_slots — individual time slots for a special
  // date override (same structure as weekly slots).
  await db.query(`
    CREATE TABLE IF NOT EXISTS district_special_date_override_slots (
      id              serial PRIMARY KEY,
      override_id     integer NOT NULL REFERENCES district_special_date_overrides(id) ON DELETE CASCADE,
      label           text NOT NULL DEFAULT '',
      start_time      text NOT NULL,
      end_time        text NOT NULL,
      is_enabled      boolean NOT NULL DEFAULT true,
      fee_override    numeric(10,2),
      cutoff_time     text,
      capacity        integer,
      internal_note   text,
      sort_order      integer NOT NULL DEFAULT 0,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_dsdos_override ON district_special_date_override_slots(override_id);`,
  );
  logger.info("district_special_date_override_slots table ready");

  // ── Seed default scheduling data for existing cities ─────────────────────
  // For each city that has no district_delivery_settings row yet, create one
  // carrying the existing express_delivery_cutoff_time (if any).
  // For each city with no weekly slots yet, seed Mon–Sat (10–12, 12–14,
  // 14–16, 16–18) and Sunday (12–16).
  {
    const cityRows = await db.query<{
      id: number;
      workspace_owner_id: string;
      express_delivery_cutoff_time: string | null;
    }>(
      `SELECT c.id, c.workspace_owner_id, c.express_delivery_cutoff_time
         FROM delivery_cities c
         LEFT JOIN district_delivery_settings dds ON dds.city_id = c.id
        WHERE dds.city_id IS NULL`,
    );
    for (const city of cityRows.rows) {
      await db.query(
        `INSERT INTO district_delivery_settings
           (city_id, workspace_owner_id)
         VALUES ($1, $2)
         ON CONFLICT (city_id) DO NOTHING`,
        [city.id, city.workspace_owner_id],
      );
    }
    if (cityRows.rows.length > 0) {
      logger.info(`district_delivery_settings: seeded ${cityRows.rows.length} new row(s)`);
    }

    // Seed default weekly slots EXACTLY ONCE per city.
    //
    // The seed must never re-introduce defaults for a city an owner has already
    // configured — even after the owner intentionally clears a day's slots, and
    // even though this routine runs on every server start. We therefore gate
    // seeding on a persistent `weekly_slots_seeded` marker on
    // district_delivery_settings rather than on whether the city currently has
    // any slots (which would re-seed an intentionally-emptied city on restart).
    //
    // Step 1: backfill the marker for every city that already has slots (e.g.
    // pre-existing/migrated cities seeded before this marker existed). They are
    // considered "already seeded" and must never be re-seeded.
    await db.query(
      `UPDATE district_delivery_settings dds
          SET weekly_slots_seeded = true
        WHERE dds.weekly_slots_seeded = false
          AND EXISTS (
            SELECT 1 FROM district_weekly_delivery_slots s
             WHERE s.city_id = dds.city_id
          )`,
    );

    // Step 2: seed defaults only for cities that have never been seeded AND
    // currently have no slots (genuinely brand-new cities). After seeding, mark
    // them so a future restart never re-seeds them.
    const citiesToSeed = await db.query<{ id: number; workspace_owner_id: string }>(
      `SELECT c.id, c.workspace_owner_id
         FROM delivery_cities c
         JOIN district_delivery_settings dds ON dds.city_id = c.id
        WHERE dds.weekly_slots_seeded = false
          AND NOT EXISTS (
            SELECT 1 FROM district_weekly_delivery_slots s
             WHERE s.city_id = c.id
          )`,
    );

    const defaultWeekdaySlots = [
      { label: "Morning",       start: "10:00", end: "12:00", sort: 0 },
      { label: "Early Afternoon", start: "12:00", end: "14:00", sort: 1 },
      { label: "Afternoon",     start: "14:00", end: "16:00", sort: 2 },
      { label: "Late Afternoon", start: "16:00", end: "18:00", sort: 3 },
    ];
    const defaultSundaySlots = [
      { label: "Afternoon",     start: "12:00", end: "16:00", sort: 0 },
    ];

    let seededCities = 0;
    for (const city of citiesToSeed.rows) {
      // Multiple server instances may run initDb concurrently. Lock the
      // persistent settings row and seed inside one transaction so only one
      // instance can claim the city. A crash rolls back both the slots and the
      // marker, allowing a later restart to retry safely.
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const claim = await client.query<{ weekly_slots_seeded: boolean }>(
          `SELECT weekly_slots_seeded
             FROM district_delivery_settings
            WHERE city_id = $1
            FOR UPDATE`,
          [city.id],
        );
        if (!claim.rows[0] || claim.rows[0].weekly_slots_seeded) {
          await client.query("ROLLBACK");
          continue;
        }

        const existing = await client.query(
          `SELECT 1
             FROM district_weekly_delivery_slots
            WHERE city_id = $1
            LIMIT 1`,
          [city.id],
        );
        if (existing.rowCount && existing.rowCount > 0) {
          await client.query(
            `UPDATE district_delivery_settings
                SET weekly_slots_seeded = true
              WHERE city_id = $1`,
            [city.id],
          );
          await client.query("COMMIT");
          continue;
        }

        // Mon–Sat (1–6)
        for (let dow = 1; dow <= 6; dow++) {
          for (const slot of defaultWeekdaySlots) {
            await client.query(
              `INSERT INTO district_weekly_delivery_slots
                 (city_id, workspace_owner_id, day_of_week, label, start_time, end_time, sort_order)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [city.id, city.workspace_owner_id, dow, slot.label, slot.start, slot.end, slot.sort],
            );
          }
        }
        // Sunday (0)
        for (const slot of defaultSundaySlots) {
          await client.query(
            `INSERT INTO district_weekly_delivery_slots
               (city_id, workspace_owner_id, day_of_week, label, start_time, end_time, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [city.id, city.workspace_owner_id, 0, slot.label, slot.start, slot.end, slot.sort],
          );
        }
        await client.query(
          `UPDATE district_delivery_settings
              SET weekly_slots_seeded = true
            WHERE city_id = $1`,
          [city.id],
        );
        await client.query("COMMIT");
        seededCities++;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    if (seededCities > 0) {
      logger.info(`district_weekly_delivery_slots: seeded default slots for ${seededCities} city/cities`);
    }
  }

  // ── Omnichannel core tables ─────────────────────────────────────────────────
  // All tables use CREATE TABLE IF NOT EXISTS — safe to re-run on every startup.

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_channel_accounts (
      id                        SERIAL PRIMARY KEY,
      workspace_owner_id        TEXT NOT NULL,
      provider                  TEXT NOT NULL,
      name                      TEXT NOT NULL,
      external_account_id       TEXT,
      access_token              TEXT,
      refresh_token             TEXT,
      token_expires_at          TIMESTAMPTZ,
      webhook_verify_token      TEXT,
      status                    TEXT NOT NULL DEFAULT 'disconnected',
      last_webhook_received_at  TIMESTAMPTZ,
      last_outbound_send_at     TIMESTAMPTZ,
      last_error                TEXT,
      is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_channel_accounts_workspace
      ON omni_channel_accounts (workspace_owner_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_channel_accounts_active
      ON omni_channel_accounts (is_active)
  `);
  logger.info("omni_channel_accounts table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_contacts (
      id                  SERIAL PRIMARY KEY,
      workspace_owner_id  TEXT NOT NULL,
      display_name        TEXT,
      phone               TEXT,
      email               TEXT,
      avatar_url          TEXT,
      metadata            JSONB,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_contacts_workspace
      ON omni_contacts (workspace_owner_id)
  `);
  logger.info("omni_contacts table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_contact_identities (
      id                  SERIAL PRIMARY KEY,
      contact_id          INTEGER NOT NULL REFERENCES omni_contacts(id) ON DELETE CASCADE,
      channel_account_id  INTEGER NOT NULL REFERENCES omni_channel_accounts(id) ON DELETE CASCADE,
      provider            TEXT NOT NULL,
      external_user_id    TEXT NOT NULL,
      display_name        TEXT,
      avatar_url          TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_contact_identities_channel_external_unique
        UNIQUE (channel_account_id, external_user_id)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_contact_identities_contact
      ON omni_contact_identities (contact_id)
  `);
  logger.info("omni_contact_identities table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_conversations (
      id                        SERIAL PRIMARY KEY,
      workspace_owner_id        TEXT NOT NULL,
      channel_account_id        INTEGER NOT NULL REFERENCES omni_channel_accounts(id) ON DELETE CASCADE,
      contact_id                INTEGER NOT NULL REFERENCES omni_contacts(id) ON DELETE CASCADE,
      provider_conversation_id  TEXT,
      status                    TEXT NOT NULL DEFAULT 'open',
      assigned_to_user_id       TEXT,
      assigned_agent_id         TEXT,
      assigned_team_id          INTEGER,
      subject                   TEXT,
      last_message_at           TIMESTAMPTZ,
      last_inbound_at           TIMESTAMPTZ,
      resolved_at               TIMESTAMPTZ,
      snoozed_until             TIMESTAMPTZ,
      metadata                  JSONB,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_conversations_channel_provider_unique
        UNIQUE (channel_account_id, provider_conversation_id)
    )
  `);
  // idx_omni_conversations_workspace was superseded by idx_omni_conversations_workspace_status
  // (which indexes workspace_owner_id + status and covers all workspace-scoped queries).
  // Drop the old standalone index from any existing database.
  await db.query(`DROP INDEX IF EXISTS idx_omni_conversations_workspace`);
  // Renamed from idx_omni_conversations_channel to match Drizzle schema index name
  await db.query(`DROP INDEX IF EXISTS idx_omni_conversations_channel`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_conversations_channel_account
      ON omni_conversations (channel_account_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_conversations_contact
      ON omni_conversations (contact_id)
  `);
  // Renamed from idx_omni_conversations_status to match Drizzle schema index name
  await db.query(`DROP INDEX IF EXISTS idx_omni_conversations_status`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_conversations_workspace_status
      ON omni_conversations (workspace_owner_id, status)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_conversations_last_message
      ON omni_conversations (last_message_at)
  `);
  logger.info("omni_conversations table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_messages (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id     INTEGER NOT NULL REFERENCES omni_conversations(id) ON DELETE CASCADE,
      workspace_owner_id  TEXT NOT NULL,
      channel_account_id  INTEGER NOT NULL REFERENCES omni_channel_accounts(id) ON DELETE CASCADE,
      direction           TEXT NOT NULL,
      message_type        TEXT NOT NULL DEFAULT 'text',
      content             TEXT,
      media_url           TEXT,
      media_mime_type     TEXT,
      media_size          BIGINT,
      template_name       TEXT,
      template_params     JSONB,
      interactive_payload JSONB,
      external_message_id TEXT,
      provider_message_id TEXT,
      sender_name         TEXT,
      sender_agent_id     TEXT,
      status              TEXT NOT NULL DEFAULT 'pending',
      error_code          TEXT,
      error_message       TEXT,
      sent_at             TIMESTAMPTZ,
      metadata            JSONB,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_messages_conversation
      ON omni_messages (conversation_id, created_at DESC)
  `);
  // idx_omni_messages_provider_id is redundant: the unique constraint
  // omni_messages_provider_msg_channel_unique on (provider_message_id, channel_account_id)
  // already creates a unique index that covers the same lookup pattern.
  // Drop the duplicate non-unique index from any existing database.
  await db.query(`DROP INDEX IF EXISTS idx_omni_messages_provider_id`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_messages_external_id
      ON omni_messages (external_message_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_messages_workspace
      ON omni_messages (workspace_owner_id)
  `);
  // Phase 8 added sender_agent_id and error_code — backfill on existing tables
  await db.query(`ALTER TABLE omni_messages ADD COLUMN IF NOT EXISTS sender_agent_id TEXT`);
  await db.query(`ALTER TABLE omni_messages ADD COLUMN IF NOT EXISTS error_code TEXT`);
  logger.info("omni_messages table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_message_events (
      id                  SERIAL PRIMARY KEY,
      message_id          UUID NOT NULL REFERENCES omni_messages(id) ON DELETE CASCADE,
      event_type          TEXT NOT NULL,
      provider_timestamp  TIMESTAMPTZ,
      error_code          TEXT,
      error_message       TEXT,
      metadata            JSONB,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_message_events_message
      ON omni_message_events (message_id)
  `);
  logger.info("omni_message_events table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_outbound_queue (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_account_id    INTEGER NOT NULL REFERENCES omni_channel_accounts(id) ON DELETE CASCADE,
      conversation_id       INTEGER NOT NULL REFERENCES omni_conversations(id) ON DELETE CASCADE,
      message_id            UUID REFERENCES omni_messages(id) ON DELETE SET NULL,
      recipient_external_id TEXT NOT NULL,
      payload               JSONB NOT NULL,
      status                TEXT NOT NULL DEFAULT 'queued',
      attempts              INTEGER NOT NULL DEFAULT 0,
      last_error            TEXT,
      next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Renamed from idx_omni_outbound_queue_queued to match Drizzle schema index name
  await db.query(`DROP INDEX IF EXISTS idx_omni_outbound_queue_queued`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_outbound_queue_status_next
      ON omni_outbound_queue (status, next_attempt_at)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_outbound_queue_conversation
      ON omni_outbound_queue (conversation_id)
  `);
  logger.info("omni_outbound_queue table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_webhook_raw_events (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_account_id  INTEGER REFERENCES omni_channel_accounts(id) ON DELETE SET NULL,
      provider            TEXT NOT NULL,
      headers             JSONB,
      payload             JSONB,
      processed_at        TIMESTAMPTZ,
      processing_error    TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_webhook_raw_events_provider
      ON omni_webhook_raw_events (provider, created_at DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_webhook_raw_events_channel
      ON omni_webhook_raw_events (channel_account_id, created_at DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_webhook_raw_events_unprocessed
      ON omni_webhook_raw_events (created_at)
      WHERE processed_at IS NULL AND processing_error IS NULL
  `);
  logger.info("omni_webhook_raw_events table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_automation_flows (
      id                  SERIAL PRIMARY KEY,
      workspace_owner_id  TEXT NOT NULL,
      name                TEXT NOT NULL,
      description         TEXT,
      trigger_type        TEXT NOT NULL,
      trigger_config      JSONB NOT NULL DEFAULT '{}',
      nodes               JSONB NOT NULL DEFAULT '[]',
      edges               JSONB NOT NULL DEFAULT '[]',
      state               TEXT NOT NULL DEFAULT 'draft',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Renamed from idx_omni_automation_flows_workspace to match Drizzle schema index name
  // (also adds the state column to the composite index)
  await db.query(`DROP INDEX IF EXISTS idx_omni_automation_flows_workspace`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_automation_flows_workspace_state
      ON omni_automation_flows (workspace_owner_id, state)
  `);
  await db.query(`ALTER TABLE omni_automation_flows ADD COLUMN IF NOT EXISTS trigger_conditions JSONB`);
  await db.query(`ALTER TABLE omni_automation_flows ADD COLUMN IF NOT EXISTS flow_graph JSONB`);
  logger.info("omni_automation_flows table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_automation_executions (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      flow_id             INTEGER NOT NULL REFERENCES omni_automation_flows(id) ON DELETE CASCADE,
      conversation_id     INTEGER REFERENCES omni_conversations(id) ON DELETE SET NULL,
      workspace_owner_id  TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'running',
      trigger_data        JSONB,
      result              JSONB,
      error_message       TEXT,
      started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at        TIMESTAMPTZ
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_automation_executions_flow
      ON omni_automation_executions (flow_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_automation_executions_conversation
      ON omni_automation_executions (conversation_id)
  `);
  await db.query(`ALTER TABLE omni_automation_executions ADD COLUMN IF NOT EXISTS context JSONB`);
  logger.info("omni_automation_executions table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_internal_notes (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id     INTEGER NOT NULL REFERENCES omni_conversations(id) ON DELETE CASCADE,
      workspace_owner_id  TEXT NOT NULL,
      author_user_id      TEXT NOT NULL,
      content             TEXT NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_internal_notes_conversation
      ON omni_internal_notes (conversation_id)
  `);
  logger.info("omni_internal_notes table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_ai_settings (
      id                    SERIAL PRIMARY KEY,
      workspace_owner_id    TEXT NOT NULL UNIQUE,
      openai_api_key        TEXT,
      auto_reply_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
      confidence_threshold  NUMERIC(4,3) NOT NULL DEFAULT 0.750,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  logger.info("omni_ai_settings table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_teams (
      id                  SERIAL PRIMARY KEY,
      workspace_owner_id  TEXT NOT NULL,
      name                TEXT NOT NULL,
      description         TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_teams_workspace
      ON omni_teams (workspace_owner_id)
  `);
  logger.info("omni_teams table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_tags (
      id                  SERIAL PRIMARY KEY,
      workspace_owner_id  TEXT NOT NULL,
      name                TEXT NOT NULL,
      color               TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT omni_tags_workspace_name_unique UNIQUE (workspace_owner_id, name)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_tags_workspace
      ON omni_tags (workspace_owner_id)
  `);
  logger.info("omni_tags table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_audit_logs (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  TEXT NOT NULL,
      actor_id            TEXT,
      actor_type          TEXT NOT NULL DEFAULT 'agent',
      action              TEXT NOT NULL,
      resource_type       TEXT,
      resource_id         TEXT,
      metadata            JSONB,
      occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Rename columns that existed under old names in earlier deployments
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'omni_audit_logs' AND column_name = 'actor_user_id'
      ) THEN
        ALTER TABLE omni_audit_logs RENAME COLUMN actor_user_id TO actor_id;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'omni_audit_logs' AND column_name = 'created_at'
      ) THEN
        ALTER TABLE omni_audit_logs RENAME COLUMN created_at TO occurred_at;
        -- Rebuild the workspace index under the new column name
        DROP INDEX IF EXISTS idx_omni_audit_logs_workspace;
      END IF;
    END $$
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_audit_logs_workspace
      ON omni_audit_logs (workspace_owner_id, occurred_at DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_audit_logs_resource
      ON omni_audit_logs (resource_type, resource_id)
  `);
  logger.info("omni_audit_logs table ready");

  // ── Omnichannel knowledge base ──────────────────────────────────────────────
  {
    await db.query(`
      CREATE TABLE IF NOT EXISTS omni_knowledge_base (
        id                SERIAL PRIMARY KEY,
        workspace_owner_id TEXT NOT NULL,
        title             TEXT NOT NULL,
        content           TEXT NOT NULL,
        category          TEXT,
        tags              TEXT[] DEFAULT '{}',
        is_published      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_omni_knowledge_base_workspace
        ON omni_knowledge_base (workspace_owner_id)
    `);
    logger.info("omni_knowledge_base table ready");
  }

  // ── Marketplace Reports ──────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS marketplace_brand_aliases (
      id                  SERIAL PRIMARY KEY,
      workspace_owner_id  TEXT NOT NULL,
      marketplace         TEXT NOT NULL DEFAULT 'toters',
      alias_name          TEXT NOT NULL,
      brand_id            INTEGER,
      location_id         INTEGER,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT marketplace_brand_aliases_workspace_marketplace_alias_unique
        UNIQUE (workspace_owner_id, marketplace, alias_name)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_brand_aliases_workspace
      ON marketplace_brand_aliases (workspace_owner_id, marketplace)
  `);
  logger.info("marketplace_brand_aliases table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS marketplace_report_imports (
      id                      SERIAL PRIMARY KEY,
      workspace_owner_id      TEXT NOT NULL,
      source_type             TEXT NOT NULL DEFAULT 'webhook_email',
      marketplace             TEXT NOT NULL DEFAULT 'toters',
      import_status           TEXT NOT NULL DEFAULT 'pending',
      pdf_storage_path        TEXT,
      pdf_sha256              TEXT,
      email_message_id        TEXT,
      detected_merchant_name  TEXT,
      detected_brand_id       INTEGER,
      detected_location_id    INTEGER,
      report_period_start     DATE,
      report_period_end       DATE,
      extracted_data          JSONB,
      notes                   TEXT,
      approved_report_id      INTEGER,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_report_imports_workspace
      ON marketplace_report_imports (workspace_owner_id, created_at DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_report_imports_brand
      ON marketplace_report_imports (workspace_owner_id, detected_brand_id)
  `);
  logger.info("marketplace_report_imports table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS marketplace_reports (
      id                  SERIAL PRIMARY KEY,
      workspace_owner_id  TEXT NOT NULL,
      import_id           INTEGER NOT NULL,
      marketplace         TEXT NOT NULL,
      brand_id            INTEGER NOT NULL,
      location_id         INTEGER NOT NULL DEFAULT 0,
      report_period_start DATE NOT NULL,
      report_period_end   DATE NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Migrate: drop the old COALESCE functional index if it exists (it uses expression
  // syntax that Replit's migration tool cannot reproduce cleanly in production).
  await db.query(`
    DROP INDEX IF EXISTS marketplace_reports_unique_per_period
  `);
  // Migrate: backfill NULLs to 0 before adding the NOT NULL constraint.
  await db.query(`
    UPDATE marketplace_reports SET location_id = 0 WHERE location_id IS NULL
  `);
  // Migrate: ensure the NOT NULL DEFAULT 0 constraint is present on existing tables.
  await db.query(`
    ALTER TABLE marketplace_reports
      ALTER COLUMN location_id SET NOT NULL,
      ALTER COLUMN location_id SET DEFAULT 0
  `);
  // Unique per (workspace, marketplace, brand, location, period).
  // location_id uses 0 as the sentinel for "global/no specific location".
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS marketplace_reports_unique_per_period
      ON marketplace_reports (
        workspace_owner_id,
        marketplace,
        brand_id,
        location_id,
        report_period_start,
        report_period_end
      )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_reports_workspace_brand
      ON marketplace_reports (workspace_owner_id, brand_id, report_period_start DESC)
  `);
  logger.info("marketplace_reports table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS marketplace_report_metrics (
      id           SERIAL PRIMARY KEY,
      report_id    INTEGER NOT NULL,
      metric_name  TEXT NOT NULL,
      metric_value NUMERIC,
      metric_unit  TEXT,
      category     TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_report_metrics_report
      ON marketplace_report_metrics (report_id)
  `);
  logger.info("marketplace_report_metrics table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS marketplace_report_weekly_trends (
      id          SERIAL PRIMARY KEY,
      report_id   INTEGER NOT NULL,
      week_label  TEXT NOT NULL,
      week_start  DATE,
      value       NUMERIC,
      metric_name TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_report_weekly_trends_report
      ON marketplace_report_weekly_trends (report_id)
  `);
  logger.info("marketplace_report_weekly_trends table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS marketplace_report_items (
      id                  SERIAL PRIMARY KEY,
      report_id           INTEGER NOT NULL,
      item_name           TEXT NOT NULL,
      rank                INTEGER,
      quantity            NUMERIC,
      revenue             NUMERIC,
      match_status        TEXT NOT NULL DEFAULT 'unmatched',
      matched_product_id  INTEGER,
      match_score         NUMERIC,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_marketplace_report_items_report
      ON marketplace_report_items (report_id)
  `);
  logger.info("marketplace_report_items table ready");

  // ── Brand Sticker Sheets ──────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS brand_sticker_sheets (
      id                    SERIAL PRIMARY KEY,
      workspace_owner_id    TEXT NOT NULL,
      brand_id              INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      file_url              TEXT NOT NULL,
      file_name             TEXT NOT NULL,
      file_size             INTEGER NOT NULL DEFAULT 0,
      thumbnail_url         TEXT,
      sheet_size            TEXT NOT NULL DEFAULT 'a4',
      custom_width          NUMERIC,
      custom_height         NUMERIC,
      sticker_count         INTEGER NOT NULL DEFAULT 1,
      status                TEXT NOT NULL DEFAULT 'pending_review',
      version_number        INTEGER NOT NULL DEFAULT 1,
      version_notes         TEXT,
      is_active             BOOLEAN NOT NULL DEFAULT FALSE,
      uploaded_by_user_id   TEXT NOT NULL,
      uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_by_user_id   TEXT,
      reviewed_at           TIMESTAMPTZ,
      approved_by_user_id   TEXT,
      approved_at           TIMESTAMPTZ,
      change_request_notes  TEXT,
      archived_at           TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bss_workspace
      ON brand_sticker_sheets (workspace_owner_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bss_brand
      ON brand_sticker_sheets (brand_id)
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bss_active_per_brand
      ON brand_sticker_sheets (brand_id)
      WHERE is_active = TRUE
  `);
  logger.info("brand_sticker_sheets table ready");

  // One-time migration: copy legacy stickers (pdf_data in DB) into brand_sticker_sheets
  // (file_url in object storage). The old stickers table stores PDFs as bytea; the new
  // brand_sticker_sheets stores them in object storage with a file_url reference.
  {
    const legacyRows = await db.query<{
      id: number;
      workspace_owner_id: string;
      brand_id: number;
      name: string;
      file_name: string;
      pdf_data: Buffer;
      thumbnail_data: Buffer | null;
      thumbnail_mime: string | null;
      created_at: string;
    }>(`
      SELECT s.id, s.workspace_owner_id, s.brand_id, s.name, s.file_name,
             s.pdf_data, s.thumbnail_data, s.thumbnail_mime, s.created_at
        FROM stickers s
       WHERE NOT EXISTS (
         SELECT 1 FROM brand_sticker_sheets bss
          WHERE bss.brand_id = s.brand_id
       )
    `);

    if (legacyRows.rowCount && legacyRows.rowCount > 0) {
      const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
      let migratedCount = 0;
      let skippedCount = 0;

      for (const row of legacyRows.rows) {
        try {
          let fileUrl: string | null = null;

          if (privateObjectDir) {
            const objectId = randomUUID();
            const fullPath = `${privateObjectDir}/${row.workspace_owner_id}/sticker-sheets/${objectId}`;
            const parts = fullPath.startsWith("/")
              ? fullPath.slice(1).split("/")
              : fullPath.split("/");
            if (parts.length >= 2) {
              const bucketName = parts[0];
              const objectName = parts.slice(1).join("/");
              const bucket = objectStorageClient.bucket(bucketName);
              const file = bucket.file(objectName);
              await file.save(row.pdf_data, {
                contentType: "application/pdf",
                resumable: false,
              });
              fileUrl = `/objects/${row.workspace_owner_id}/sticker-sheets/${objectId}`;
            }
          }

          let thumbnailUrl: string | null = null;
          if (row.thumbnail_data && row.thumbnail_mime && privateObjectDir) {
            const thumbId = randomUUID();
            const fullThumbPath = `${privateObjectDir}/${row.workspace_owner_id}/sticker-sheet-thumbnails/${thumbId}`;
            const thumbParts = fullThumbPath.startsWith("/")
              ? fullThumbPath.slice(1).split("/")
              : fullThumbPath.split("/");
            if (thumbParts.length >= 2) {
              const thumbBucket = thumbParts[0];
              const thumbObject = thumbParts.slice(1).join("/");
              const bucket = objectStorageClient.bucket(thumbBucket);
              const file = bucket.file(thumbObject);
              await file.save(row.thumbnail_data, {
                contentType: row.thumbnail_mime,
                resumable: false,
              });
              thumbnailUrl = `/objects/${row.workspace_owner_id}/sticker-sheet-thumbnails/${thumbId}`;
            }
          }

          await db.query(
            `INSERT INTO brand_sticker_sheets
               (workspace_owner_id, brand_id, file_url, file_name, file_size,
                thumbnail_url, sheet_size, sticker_count, status, version_number,
                is_active, uploaded_by_user_id, uploaded_at,
                approved_by_user_id, approved_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)`,
            [
              row.workspace_owner_id,
              row.brand_id,
              fileUrl ?? "",
              row.file_name,
              row.pdf_data.length,
              thumbnailUrl,
              "a4",
              1,
              "print_ready",
              1,
              true,
              row.workspace_owner_id,
              row.created_at,
              row.workspace_owner_id,
              row.created_at,
              row.created_at,
            ],
          );
          migratedCount++;
        } catch (err) {
          logger.warn(
            { err, stickerId: row.id, brandId: row.brand_id },
            "sticker-to-brand-sheet migration: single-row upload failed — skipping",
          );
          skippedCount++;
        }
      }

      logger.info(
        `sticker-to-brand-sheet migration: ${migratedCount} migrated, ${skippedCount} skipped (of ${legacyRows.rows.length} legacy rows)`,
      );
    } else {
      logger.info("sticker-to-brand-sheet migration: no legacy stickers to migrate");
    }
  }

  // ── Brand Sticker Sheet Audit Log ─────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS brand_sticker_sheet_audit_log (
      id                SERIAL PRIMARY KEY,
      workspace_owner_id TEXT NOT NULL,
      sheet_id          INTEGER,
      brand_id          INTEGER,
      brand_name        TEXT NOT NULL,
      version_number    INTEGER,
      file_name         TEXT,
      action            TEXT NOT NULL,
      actor_user_id     TEXT NOT NULL,
      actor_email       TEXT,
      notes             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bss_audit_workspace
      ON brand_sticker_sheet_audit_log (workspace_owner_id, created_at DESC)
  `);
  logger.info("brand_sticker_sheet_audit_log table ready");

  // ── Global sequence-drift repair ────────────────────────────────────────────
  // After bulk imports or explicit-ID inserts the serial sequences can fall
  // behind the actual MAX(id), causing spurious 23505 PK violations on the
  // next INSERT. This block resets every sequence in the public schema to
  // MAX(id) of its owning table — idempotent and safe to run on every startup.
  {
    const seqRows = await db.query<{
      seq: string;
      tbl: string;
      col: string;
    }>(`
      SELECT
        s.relname                                      AS seq,
        t.relname                                      AS tbl,
        a.attname                                      AS col
      FROM   pg_class       s
      JOIN   pg_depend      d ON d.objid     = s.oid AND d.deptype = 'a'
      JOIN   pg_class       t ON t.oid       = d.refobjid
      JOIN   pg_attribute   a ON a.attrelid  = t.oid  AND a.attnum = d.refobjsubid
      WHERE  s.relkind = 'S'
        AND  t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      ORDER  BY s.relname
    `);

    for (const { seq, tbl, col } of seqRows.rows) {
      await db.query(
        `SELECT setval($1, GREATEST((SELECT COALESCE(MAX(${col}), 0) FROM "${tbl}"), 1))`,
        [seq],
      );
    }
    logger.info(`sequence drift repair complete (${seqRows.rows.length} sequences reset)`);
  }

  // Normalise delivery_cities.country_code to uppercase.
  // Legacy cities endpoint stored codes in lowercase (e.g. "lb"); the admin
  // count query compares against uppercase codes, so they were never matched.
  // Before uppercasing, remove any lowercase rows that would create a duplicate
  // once their country_code is uppercased (an uppercase twin already exists).
  const citiesDupDeleteResult = await db.query(`
    DELETE FROM delivery_cities dc_lower
     WHERE dc_lower.country_code != UPPER(dc_lower.country_code)
       AND EXISTS (
         SELECT 1 FROM delivery_cities dc_upper
          WHERE dc_upper.workspace_owner_id = dc_lower.workspace_owner_id
            AND dc_upper.country_code       = UPPER(dc_lower.country_code)
            AND dc_upper.slug               = dc_lower.slug
       )
  `);
  if (citiesDupDeleteResult.rowCount && citiesDupDeleteResult.rowCount > 0) {
    logger.info(
      `delivery_cities country_code normalisation: removed ${citiesDupDeleteResult.rowCount} superseded lowercase duplicate(s)`,
    );
  }
  const citiesUpperResult = await db.query(`
    UPDATE delivery_cities
       SET country_code = UPPER(country_code)
     WHERE country_code != UPPER(country_code)
  `);
  if (citiesUpperResult.rowCount && citiesUpperResult.rowCount > 0) {
    logger.info(
      `delivery_cities country_code normalisation: uppercased ${citiesUpperResult.rowCount} row(s)`,
    );
  } else {
    logger.info("delivery_cities country_code normalisation: all rows already uppercase — no action needed");
  }

  // Normalise delivery_country_settings.country_code to uppercase (same fix).
  // Before uppercasing, remove any lowercase rows that would create a duplicate
  // once their country_code is uppercased (an uppercase twin already exists).
  const countrySettingsDupDeleteResult = await db.query(`
    DELETE FROM delivery_country_settings dcs_lower
     WHERE dcs_lower.country_code != UPPER(dcs_lower.country_code)
       AND EXISTS (
         SELECT 1 FROM delivery_country_settings dcs_upper
          WHERE dcs_upper.workspace_owner_id = dcs_lower.workspace_owner_id
            AND dcs_upper.country_code       = UPPER(dcs_lower.country_code)
       )
  `);
  if (countrySettingsDupDeleteResult.rowCount && countrySettingsDupDeleteResult.rowCount > 0) {
    logger.info(
      `delivery_country_settings country_code normalisation: removed ${countrySettingsDupDeleteResult.rowCount} superseded lowercase duplicate(s)`,
    );
  }
  const countrySettingsUpperResult = await db.query(`
    UPDATE delivery_country_settings
       SET country_code = UPPER(country_code)
     WHERE country_code != UPPER(country_code)
  `);
  if (countrySettingsUpperResult.rowCount && countrySettingsUpperResult.rowCount > 0) {
    logger.info(
      `delivery_country_settings country_code normalisation: uppercased ${countrySettingsUpperResult.rowCount} row(s)`,
    );
  } else {
    logger.info("delivery_country_settings country_code normalisation: all rows already uppercase — no action needed");
  }

  // People directory tables (May 2026)
  await db.query(`
    CREATE TABLE IF NOT EXISTS people (
      id serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      first_name text NOT NULL,
      last_name text,
      display_name text,
      email text,
      phone text,
      avatar_url text,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz
    );
  `);
  logger.info("people table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS team_member_profiles (
      id serial PRIMARY KEY,
      person_id integer REFERENCES people(id) ON DELETE CASCADE,
      workspace_owner_id text NOT NULL,
      employee_code text,
      department_id integer,
      job_title text,
      manager_person_id integer,
      employment_type text NOT NULL DEFAULT 'full_time',
      start_date date,
      work_location_id integer,
      work_schedule_id integer,
      time_off_policy_id integer,
      attendance_enabled boolean NOT NULL DEFAULT false,
      emergency_contact_name text,
      emergency_contact_phone text,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  logger.info("team_member_profiles table ready");

  // work_schedules — must exist before team_member_profiles attendance FK is added
  await db.query(`
    CREATE TABLE IF NOT EXISTS work_schedules (
      id            serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      name          text NOT NULL,
      description   text,
      status        text NOT NULL DEFAULT 'active',
      default_timezone text NOT NULL DEFAULT 'UTC',
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  logger.info("work_schedules table ready");

  // work_schedule_days — daily windows per schedule
  await db.query(`
    CREATE TABLE IF NOT EXISTS work_schedule_days (
      id            serial PRIMARY KEY,
      schedule_id   integer NOT NULL REFERENCES work_schedules(id) ON DELETE CASCADE,
      day_of_week   text NOT NULL,
      is_working_day boolean NOT NULL DEFAULT true,
      start_time    time,
      end_time      time,
      break_minutes integer NOT NULL DEFAULT 0,
      notes         text
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_wsd_schedule_day
      ON work_schedule_days(schedule_id, day_of_week);
  `);
  logger.info("work_schedule_days table ready");

  // work_schedule_assignments — links an employee to a schedule for a date range
  await db.query(`
    CREATE TABLE IF NOT EXISTS work_schedule_assignments (
      id              serial PRIMARY KEY,
      schedule_id     integer NOT NULL REFERENCES work_schedules(id) ON DELETE CASCADE,
      employee_id     integer NOT NULL,
      effective_date  date NOT NULL,
      end_date        date,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  logger.info("work_schedule_assignments table ready");

  // work_schedule_exceptions — non-standard days (holidays, special hours) within a schedule
  await db.query(`
    CREATE TABLE IF NOT EXISTS work_schedule_exceptions (
      id                    serial PRIMARY KEY,
      schedule_id           integer NOT NULL REFERENCES work_schedules(id) ON DELETE CASCADE,
      name                  text NOT NULL,
      start_date            date NOT NULL,
      end_date              date NOT NULL,
      affected_location_ids text,
      affected_employee_ids text,
      is_working_day        boolean,
      start_time            time,
      end_time              time,
      notes                 text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  logger.info("work_schedule_exceptions table ready");

  // departments — organisational groupings for team members
  await db.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      description         text,
      status              text NOT NULL DEFAULT 'active',
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_departments_workspace
      ON departments(workspace_owner_id);
  `);
  logger.info("departments table ready");

  // team_members — HR employee records for attendance and scheduling
  await db.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id                              serial PRIMARY KEY,
      workspace_owner_id              text NOT NULL,
      member_db_id                    integer,
      first_name                      text NOT NULL,
      last_name                       text,
      email                           text,
      phone                           text,
      department_id                   integer REFERENCES departments(id) ON DELETE SET NULL,
      location_id                     integer,
      manager_id                      integer,
      employment_status               text NOT NULL DEFAULT 'full_time',
      start_date                      date,
      birthday                        date,
      emergency_contact_name          text,
      emergency_contact_phone         text,
      emergency_contact_relationship  text,
      leave_policy_id                 integer,
      work_schedule_id                integer,
      notes                           text,
      expo_push_token                 text,
      archived_at                     timestamptz,
      created_at                      timestamptz NOT NULL DEFAULT now(),
      updated_at                      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_team_members_workspace
      ON team_members(workspace_owner_id);
  `);
  logger.info("team_members table ready");

  // Location activity log — append-only log for removal events (brand_removed, member_removed).
  // Addition events are tracked inline on location_brands/member_locations tables.
  await db.query(`
    CREATE TABLE IF NOT EXISTS location_activity_log (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      location_id         integer NOT NULL,
      event_type          text NOT NULL,
      subject_id          text,
      subject_name        text,
      actor_email         text,
      occurred_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'location_activity_log'
            AND indexname  = 'idx_location_activity_log_location'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_location_activity_log_location
         ON location_activity_log(workspace_owner_id, location_id, occurred_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_location_activity_log_location: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_location_activity_log_location: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("location_activity_log table ready");

  // ── People-directory linkage migration ────────────────────────────────────
  // team_members is now created above by initDb (idempotent CREATE TABLE IF NOT EXISTS).
  // Guard retained for safety in case this block runs on a very old deployment.
  {
    const tmExists = await db.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name   = 'team_members'
      ) AS exists;
    `);

    if (!tmExists.rows[0]?.exists) {
      logger.info("people-directory linkage: team_members table not yet present — skipping");
    } else {
      // Add team_member_id column to team_member_profiles for idempotent linkage.
      await db.query(`
        ALTER TABLE team_member_profiles
          ADD COLUMN IF NOT EXISTS team_member_id integer REFERENCES team_members(id) ON DELETE SET NULL;
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_tmp_team_member_id
          ON team_member_profiles (team_member_id)
          WHERE team_member_id IS NOT NULL;
      `);
      logger.info("team_member_profiles.team_member_id column ready");

      // For every team_member row that does not yet have a linked
      // team_member_profiles record, create a people row (or reuse an existing
      // one matched by email+workspace) and then create the profile row.
      const migrationResult = await db.query<{ linked: string }>(`
        SELECT COUNT(*) AS linked FROM team_member_profiles WHERE team_member_id IS NOT NULL;
      `);
      const alreadyLinked = parseInt(migrationResult.rows[0]?.linked ?? "0", 10);

      await db.query(`
        DO $$
        DECLARE
          tm  RECORD;
          pid INTEGER;
        BEGIN
          FOR tm IN
            SELECT *
              FROM team_members
             WHERE NOT EXISTS (
               SELECT 1
                 FROM team_member_profiles tmp
                WHERE tmp.team_member_id = team_members.id
             )
          LOOP
            pid := NULL;

            -- Reuse an existing people row matched by email+workspace
            IF tm.email IS NOT NULL THEN
              SELECT id INTO pid
                FROM people
               WHERE workspace_owner_id = tm.workspace_owner_id
                 AND LOWER(email) = LOWER(tm.email)
               LIMIT 1;
            END IF;

            -- No people row found — create one from the team_member data
            IF pid IS NULL THEN
              INSERT INTO people (
                workspace_owner_id,
                first_name, last_name,
                email, phone,
                status, archived_at
              )
              VALUES (
                tm.workspace_owner_id,
                tm.first_name, tm.last_name,
                tm.email, tm.phone,
                CASE WHEN tm.archived_at IS NOT NULL THEN 'archived' ELSE 'active' END,
                tm.archived_at
              )
              RETURNING id INTO pid;
            END IF;

            -- Create the team_member_profiles row linking people ↔ team_member
            INSERT INTO team_member_profiles (
              person_id, workspace_owner_id,
              team_member_id,
              department_id,
              employment_type, start_date,
              emergency_contact_name, emergency_contact_phone,
              status
            )
            VALUES (
              pid, tm.workspace_owner_id,
              tm.id,
              tm.department_id,
              tm.employment_status, tm.start_date,
              tm.emergency_contact_name, tm.emergency_contact_phone,
              CASE WHEN tm.archived_at IS NOT NULL THEN 'archived' ELSE 'active' END
            );
          END LOOP;
        END $$;
      `);

      const afterResult = await db.query<{ linked: string }>(`
        SELECT COUNT(*) AS linked FROM team_member_profiles WHERE team_member_id IS NOT NULL;
      `);
      const nowLinked = parseInt(afterResult.rows[0]?.linked ?? "0", 10);
      const newlyLinked = nowLinked - alreadyLinked;
      if (newlyLinked > 0) {
        logger.info(
          `people-directory linkage: created ${newlyLinked} new people/profile record(s) from team_members`,
        );
      } else {
        logger.info("people-directory linkage: all team_members already linked — no action needed");
      }

      // ── Orphan health-check ───────────────────────────────────────────────
      // After the linkage migration, every team_member row should have a
      // matching team_member_profiles row.  Log a warning for any that are
      // still missing so silent migration failures surface immediately.
      const orphanResult = await db.query<{
        workspace_owner_id: string;
        orphan_count: string;
      }>(`
        SELECT tm.workspace_owner_id, COUNT(*) AS orphan_count
          FROM team_members tm
         WHERE NOT EXISTS (
           SELECT 1
             FROM team_member_profiles tmp
            WHERE tmp.team_member_id = tm.id
         )
         GROUP BY tm.workspace_owner_id;
      `);
      if (orphanResult.rows.length > 0) {
        for (const row of orphanResult.rows) {
          logger.warn(
            {
              workspace_owner_id: row.workspace_owner_id,
              orphan_count: parseInt(row.orphan_count, 10),
            },
            "people-directory linkage: team_members rows exist without a linked team_member_profiles row — job_title accuracy may be affected",
          );
        }
      } else {
        logger.info("people-directory linkage: orphan check passed — all team_members have a linked profile row");
      }
    }
  }

  // ── Remove stale job_title column and sync trigger from team_members ─────────
  // team_member_profiles.job_title is now the single source of truth.
  // Drop the trigger, its backing function, and the now-redundant column.
  {
    const tmExists = await db.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name   = 'team_members'
      ) AS exists;
    `);

    if (!tmExists.rows[0]?.exists) {
      logger.info("job_title cleanup: team_members table not yet present — skipping");
    } else {
      await db.query(`
        DROP TRIGGER IF EXISTS trg_sync_job_title_to_team_member
          ON team_member_profiles;
      `);
      await db.query(`
        DROP FUNCTION IF EXISTS sync_job_title_to_team_member();
      `);
      await db.query(`
        ALTER TABLE team_members DROP COLUMN IF EXISTS job_title;
      `);
      logger.info("job_title cleanup: trigger, function, and column removed from team_members");
    }
  }

  // blackout_dates — workspace-level date ranges that restrict or warn on time-off requests
  await db.query(`
    CREATE TABLE IF NOT EXISTS blackout_dates (
      id                      serial PRIMARY KEY,
      workspace_owner_id      text NOT NULL,
      name                    text NOT NULL,
      description             text,
      start_date              date NOT NULL,
      end_date                date NOT NULL,
      restriction_type        text NOT NULL DEFAULT 'warning_only',
      affected_location_ids   text,
      affected_department_ids text,
      affected_employee_ids   text,
      affected_leave_type_ids text,
      employee_message        text,
      allow_exceptions        boolean NOT NULL DEFAULT false,
      exception_approver_type text,
      status                  text NOT NULL DEFAULT 'upcoming',
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'blackout_dates'
            AND indexname  = 'idx_blackout_dates_workspace'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_blackout_dates_workspace ON blackout_dates(workspace_owner_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_blackout_dates_workspace: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_blackout_dates_workspace: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("blackout_dates table ready");

  // people_audit_log — field-level change history for team member HR profiles
  await db.query(`
    CREATE TABLE IF NOT EXISTS people_audit_log (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      team_member_id     integer NOT NULL,
      changed_by_user_id text NOT NULL,
      field_name         text NOT NULL,
      old_value          text,
      new_value          text,
      changed_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_pal_team_member
      ON people_audit_log(team_member_id, changed_at DESC);
  `);
  logger.info("people_audit_log table ready");

  // external_profiles — contacts/consultants/auditors with optional limited access
  await db.query(`
    CREATE TABLE IF NOT EXISTS external_profiles (
      id                       serial PRIMARY KEY,
      workspace_owner_id       text NOT NULL,
      person_id                integer NOT NULL,
      external_type            text NOT NULL DEFAULT 'other',
      company_name             text,
      internal_owner_person_id integer,
      reason_for_access        text,
      notes                    text,
      status                   text NOT NULL DEFAULT 'active',
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_owner_id, person_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_external_profiles_workspace
      ON external_profiles(workspace_owner_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_external_profiles_person
      ON external_profiles(person_id, workspace_owner_id);
  `);
  logger.info("external_profiles table ready");

  // workspace_members — access expiry and revoke tracking columns
  await db.query(`
    ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS access_expires_at timestamptz;
  `);
  await db.query(`
    ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS revoked_by text;
  `);
  await db.query(`
    ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
  `);
  logger.info("workspace_members access expiry columns ready");

  // ── Attendance Extensions ────────────────────────────────────────────────

  // locations — add geofencing and attendance columns
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS latitude double precision;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS longitude double precision;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS geofence_radius_meters integer NOT NULL DEFAULT 100;`);
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS attendance_enabled boolean NOT NULL DEFAULT true;`);
  logger.info("locations geofencing columns ready");

  // team_member_profiles — attendance-specific profile columns
  await db.query(`ALTER TABLE team_member_profiles ADD COLUMN IF NOT EXISTS allowed_remote_clock_in boolean NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE team_member_profiles ADD COLUMN IF NOT EXISTS default_schedule_id integer;`);
  await db.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'team_member_profiles' AND column_name = 'default_schedule_id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'team_member_profiles'
          AND kcu.column_name = 'default_schedule_id'
          AND tc.constraint_type = 'FOREIGN KEY'
      ) THEN
        ALTER TABLE team_member_profiles
          ADD CONSTRAINT fk_default_schedule
          FOREIGN KEY (default_schedule_id) REFERENCES work_schedules(id)
          ON DELETE SET NULL;
      END IF;
    END $$;
  `);
  logger.info("team_member_profiles attendance columns ready");

  // attendance_sessions — full punch-clock session per shift
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id                            serial PRIMARY KEY,
      workspace_owner_id            text NOT NULL,
      employee_id                   integer NOT NULL,
      location_id                   integer,
      scheduled_shift_id            integer,
      clock_in_at                   timestamptz NOT NULL,
      clock_out_at                  timestamptz,
      clock_in_latitude             double precision,
      clock_in_longitude            double precision,
      clock_in_accuracy_meters      double precision,
      clock_in_distance_meters      double precision,
      clock_out_latitude            double precision,
      clock_out_longitude           double precision,
      clock_out_accuracy_meters     double precision,
      clock_out_distance_meters     double precision,
      clock_in_verification_status  text NOT NULL DEFAULT 'no_location',
      clock_out_verification_status text,
      status                        text NOT NULL DEFAULT 'open',
      late_minutes                  integer NOT NULL DEFAULT 0,
      early_leave_minutes           integer NOT NULL DEFAULT 0,
      gross_minutes                 integer,
      break_minutes                 integer NOT NULL DEFAULT 0,
      paid_minutes                  integer,
      overtime_minutes              integer NOT NULL DEFAULT 0,
      employee_note                 text,
      manager_note                  text,
      approved_by                   text,
      approved_at                   timestamptz,
      rejected_by                   text,
      rejected_at                   timestamptz,
      created_at                    timestamptz NOT NULL DEFAULT now(),
      updated_at                    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_att_sessions_workspace ON attendance_sessions(workspace_owner_id, clock_in_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_att_sessions_employee ON attendance_sessions(employee_id, clock_in_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_att_sessions_status ON attendance_sessions(workspace_owner_id, status);`);
  await db.query(`ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS missed_clockout_notif_sent_at timestamptz;`);
  await db.query(`ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS missed_clockout_reminder_sent_at timestamptz;`);
  // Unique index on (workspace_owner_id, employee_id, clock_in_at) prevents duplicate
  // open sessions when a missed clock-in request is approved more than once concurrently.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_att_sessions_uniq_emp_clockin
      ON attendance_sessions(workspace_owner_id, employee_id, clock_in_at);
  `);
  // Narrower unique index on (employee_id, clock_in_at) provides an unconditional
  // DB-level guarantee independent of workspace_owner_id. Any INSERT that omits
  // ON CONFLICT will raise error code 23505, which the approve handler catches and
  // surfaces as a 409 rather than letting a 500 propagate.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_att_sessions_uniq_emp_clockin_narrow
      ON attendance_sessions(employee_id, clock_in_at);
  `);
  logger.info("attendance_sessions table ready");

  // attendance_breaks — break periods within a session
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_breaks (
      id                    serial PRIMARY KEY,
      attendance_session_id integer NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      employee_id           integer NOT NULL,
      break_start_at        timestamptz NOT NULL,
      break_end_at          timestamptz,
      break_type            text NOT NULL DEFAULT 'other',
      note                  text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_att_breaks_session ON attendance_breaks(attendance_session_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_att_breaks_employee ON attendance_breaks(employee_id, break_start_at DESC);`);
  logger.info("attendance_breaks table ready");

  // attendance_requests — employee correction and offsite requests
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_requests (
      id                      serial PRIMARY KEY,
      workspace_owner_id      text NOT NULL,
      employee_id             integer NOT NULL,
      attendance_session_id   integer REFERENCES attendance_sessions(id) ON DELETE SET NULL,
      request_type            text NOT NULL,
      requested_clock_in_at   timestamptz,
      requested_clock_out_at  timestamptz,
      requested_location_id   integer,
      reason                  text,
      status                  text NOT NULL DEFAULT 'pending',
      reviewed_by             text,
      reviewed_at             timestamptz,
      reviewer_note           text,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_att_requests_workspace ON attendance_requests(workspace_owner_id, status, created_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_att_requests_employee ON attendance_requests(employee_id, created_at DESC);`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_att_requests_pending_session_type
      ON attendance_requests(employee_id, attendance_session_id, request_type)
      WHERE status = 'pending';
  `);
  // PostgreSQL treats NULLs as distinct in unique indexes, so the index above
  // does NOT prevent duplicate pending rows when attendance_session_id IS NULL.
  // This second partial index covers that gap by enforcing uniqueness on
  // (employee_id, request_type) for standalone requests with no linked session.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_att_requests_pending_null_session_type
      ON attendance_requests(employee_id, request_type)
      WHERE status = 'pending' AND attendance_session_id IS NULL;
  `);
  await db.query(`
    ALTER TABLE attendance_requests ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
  `);
  logger.info("attendance_requests table ready");

  // attendance_audit_logs — immutable record of every approval, edit, lock
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_audit_logs (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      attendance_session_id integer REFERENCES attendance_sessions(id) ON DELETE SET NULL,
      attendance_request_id integer REFERENCES attendance_requests(id) ON DELETE SET NULL,
      actor_user_id         text NOT NULL,
      action                text NOT NULL,
      old_value_json        jsonb,
      new_value_json        jsonb,
      created_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_att_audit_session ON attendance_audit_logs(attendance_session_id, created_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_att_audit_workspace ON attendance_audit_logs(workspace_owner_id, created_at DESC);`);
  logger.info("attendance_audit_logs table ready");

  // ── Attendance Settings Extensions ───────────────────────────────────────────

  // work_schedules — overtime threshold and break policy per schedule
  await db.query(`
    ALTER TABLE work_schedules
      ADD COLUMN IF NOT EXISTS overtime_after_minutes integer NOT NULL DEFAULT 480;
  `);
  await db.query(`
    ALTER TABLE work_schedules
      ADD COLUMN IF NOT EXISTS break_policy_minutes integer NOT NULL DEFAULT 0;
  `);
  logger.info("work_schedules attendance settings columns ready");

  // locations — default_schedule_id FK for per-location schedule assignment
  await db.query(`
    ALTER TABLE locations ADD COLUMN IF NOT EXISTS default_schedule_id integer;
  `);
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'locations'
          AND kcu.column_name = 'default_schedule_id'
          AND tc.constraint_type = 'FOREIGN KEY'
      ) THEN
        ALTER TABLE locations
          ADD CONSTRAINT fk_locations_default_schedule
          FOREIGN KEY (default_schedule_id) REFERENCES work_schedules(id)
          ON DELETE SET NULL;
      END IF;
    END $$;
  `);
  logger.info("locations default_schedule_id column ready");

  // UI preference — tracks which person type the user last selected in Add Person dialog.
  // Stored server-side so it persists across browsers and devices.
  await db.query(`
    ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS pref_add_person_last_type text;
  `);
  logger.info("workspace_members.pref_add_person_last_type column ready");

  // ── Occasion Campaign Calendar ────────────────────────────────────────────

  // occasion_campaigns — recurring flower-commerce occasions (per workspace)
  await db.query(`
    CREATE TABLE IF NOT EXISTS occasion_campaigns (
      id                          serial PRIMARY KEY,
      workspace_owner_id          text NOT NULL,
      name                        text NOT NULL,
      type                        text NOT NULL DEFAULT 'seasonal',
      markets                     jsonb NOT NULL DEFAULT '[]',
      product_focus               text,
      recommended_channels        jsonb NOT NULL DEFAULT '[]',
      campaign_start_days_before  integer NOT NULL DEFAULT 30,
      month                       integer,
      day                         integer,
      notes                       text,
      is_active                   boolean NOT NULL DEFAULT true,
      created_at                  timestamptz DEFAULT now(),
      updated_at                  timestamptz DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_occasion_campaigns_workspace ON occasion_campaigns(workspace_owner_id, is_active);`);
  logger.info("occasion_campaigns table ready");

  // campaign_plans — marketing campaign plans tied to an occasion
  await db.query(`
    CREATE TABLE IF NOT EXISTS campaign_plans (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      occasion_id           integer NOT NULL REFERENCES occasion_campaigns(id) ON DELETE CASCADE,
      name                  text NOT NULL,
      target_date           date NOT NULL,
      markets               jsonb NOT NULL DEFAULT '[]',
      budget                numeric(12,2),
      currency              text NOT NULL DEFAULT 'AED',
      notes                 text,
      status                text NOT NULL DEFAULT 'draft',
      created_at            timestamptz DEFAULT now(),
      updated_at            timestamptz DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_campaign_plans_workspace ON campaign_plans(workspace_owner_id, target_date);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_campaign_plans_occasion ON campaign_plans(occasion_id);`);
  logger.info("campaign_plans table ready");

  // campaign_actions — checklist items for a campaign plan
  await db.query(`
    CREATE TABLE IF NOT EXISTS campaign_actions (
      id          serial PRIMARY KEY,
      plan_id     integer NOT NULL REFERENCES campaign_plans(id) ON DELETE CASCADE,
      title       text NOT NULL,
      description text,
      status      text NOT NULL DEFAULT 'not_started',
      due_date    date,
      created_at  timestamptz DEFAULT now(),
      updated_at  timestamptz DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_campaign_actions_plan ON campaign_actions(plan_id);`);
  logger.info("campaign_actions table ready");

  // ui_preferences — per-member UI preference blob (cross-device persistence)
  await db.query(`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS ui_preferences jsonb NOT NULL DEFAULT '{}';`);
  logger.info("workspace_members.ui_preferences column ready");

  // ── Occasion Campaigns — schema extensions ────────────────────────────────

  // occasion_campaigns extended fields (priority, status, description, recurrence, etc.)
  await db.query(`ALTER TABLE occasion_campaigns ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'medium';`);
  await db.query(`ALTER TABLE occasion_campaigns ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';`);
  await db.query(`ALTER TABLE occasion_campaigns ADD COLUMN IF NOT EXISTS description text;`);
  await db.query(`ALTER TABLE occasion_campaigns ADD COLUMN IF NOT EXISTS recurrence text NOT NULL DEFAULT 'annual_fixed';`);
  await db.query(`ALTER TABLE occasion_campaigns ADD COLUMN IF NOT EXISTS preparation_days integer;`);
  await db.query(`ALTER TABLE occasion_campaigns ADD COLUMN IF NOT EXISTS demand_level text;`);
  await db.query(`ALTER TABLE occasion_campaigns ADD COLUMN IF NOT EXISTS owner_user_id text;`);
  await db.query(`ALTER TABLE occasion_campaigns ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]';`);
  logger.info("occasion_campaigns extended columns ready");

  // campaign_plans extended fields (channel, market, owner, dates, goal)
  await db.query(`ALTER TABLE campaign_plans ADD COLUMN IF NOT EXISTS channel text;`);
  await db.query(`ALTER TABLE campaign_plans ADD COLUMN IF NOT EXISTS market text;`);
  await db.query(`ALTER TABLE campaign_plans ADD COLUMN IF NOT EXISTS owner_user_id text;`);
  await db.query(`ALTER TABLE campaign_plans ADD COLUMN IF NOT EXISTS start_date date;`);
  await db.query(`ALTER TABLE campaign_plans ADD COLUMN IF NOT EXISTS end_date date;`);
  await db.query(`ALTER TABLE campaign_plans ADD COLUMN IF NOT EXISTS goal text;`);
  logger.info("campaign_plans extended columns ready");

  // occasion_types — workspace-scoped custom occasion types with color
  await db.query(`
    CREATE TABLE IF NOT EXISTS occasion_types (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      color               text NOT NULL DEFAULT '#6366f1',
      description         text,
      created_at          timestamptz DEFAULT now(),
      updated_at          timestamptz DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_occasion_types_workspace ON occasion_types(workspace_owner_id);`);
  logger.info("occasion_types table ready");

  // occasion_readiness_items — checklist items tracking readiness per occasion
  await db.query(`
    CREATE TABLE IF NOT EXISTS occasion_readiness_items (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      occasion_id         integer NOT NULL REFERENCES occasion_campaigns(id) ON DELETE CASCADE,
      title               text NOT NULL,
      category            text NOT NULL DEFAULT 'general',
      status              text NOT NULL DEFAULT 'not_started',
      owner_user_id       text,
      due_date            date,
      notes               text,
      is_default          boolean NOT NULL DEFAULT false,
      created_at          timestamptz DEFAULT now(),
      updated_at          timestamptz DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_readiness_items_occasion ON occasion_readiness_items(occasion_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_readiness_items_workspace ON occasion_readiness_items(workspace_owner_id);`);
  logger.info("occasion_readiness_items table ready");

  // ── Tables defined in lib/db/src/schema/* that must exist after initDb ──────
  // These were added to the Drizzle schema as the canonical source of truth;
  // the matching CREATE TABLE IF NOT EXISTS blocks here ensure a fresh
  // deployment gets them without needing a separate Drizzle push step.

  // attendance_records — simple per-day attendance log (lib/db/src/schema/people.ts)
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      employee_id         integer NOT NULL,
      attendance_date     date NOT NULL,
      scheduled_start     time,
      scheduled_end       time,
      clock_in            timestamptz,
      clock_out           timestamptz,
      break_minutes       integer NOT NULL DEFAULT 0,
      total_minutes       integer,
      status              text NOT NULL DEFAULT 'present',
      location_id         integer,
      source              text NOT NULL DEFAULT 'manual',
      notes               text,
      created_by          text,
      updated_by          text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_attendance_records_workspace
      ON attendance_records (workspace_owner_id, attendance_date DESC);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_attendance_records_employee
      ON attendance_records (employee_id, attendance_date DESC);
  `);
  logger.info("attendance_records table ready");

  // driver_otp_codes — OTP verification codes for fleet driver login (lib/db/src/schema/fleet.ts)
  await db.query(`
    CREATE TABLE IF NOT EXISTS driver_otp_codes (
      id              serial PRIMARY KEY,
      phone_number    text NOT NULL,
      code_hash       text NOT NULL,
      expires_at      timestamptz NOT NULL,
      used            boolean NOT NULL DEFAULT false,
      failed_attempts integer NOT NULL DEFAULT 0,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_driver_otp_codes_phone
      ON driver_otp_codes (phone_number, expires_at DESC);
  `);
  logger.info("driver_otp_codes table ready");

  // otp_rate_limits — shared abuse controls for public OTP endpoints
  await db.query(`
    CREATE TABLE IF NOT EXISTS otp_rate_limits (
      bucket_hash        text PRIMARY KEY,
      request_count      integer NOT NULL DEFAULT 1,
      window_expires_at  timestamptz NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_otp_rate_limits_expiry
      ON otp_rate_limits (window_expires_at);
  `);
  logger.info("otp_rate_limits table ready");

  // omni_team_members — members of omnichannel teams (lib/db/src/schema/omnichannel.ts)
  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_team_members (
      id          serial PRIMARY KEY,
      team_id     integer NOT NULL REFERENCES omni_teams(id) ON DELETE CASCADE,
      agent_id    text NOT NULL,
      role        text NOT NULL DEFAULT 'agent',
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT omni_team_members_team_agent_unique UNIQUE (team_id, agent_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_team_members_team
      ON omni_team_members (team_id);
  `);
  logger.info("omni_team_members table ready");

  // omni_assignment_rules — auto-assignment rules for conversations
  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_assignment_rules (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      name                text NOT NULL,
      is_active           boolean NOT NULL DEFAULT true,
      priority            integer NOT NULL DEFAULT 0,
      conditions          jsonb NOT NULL DEFAULT '{}',
      assign_to_team_id   integer REFERENCES omni_teams(id) ON DELETE SET NULL,
      assign_to_agent_id  text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_assignment_rules_workspace
      ON omni_assignment_rules (workspace_owner_id, is_active);
  `);
  logger.info("omni_assignment_rules table ready");

  // omni_saved_replies — canned/template replies (lib/db/src/schema/omnichannel.ts)
  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_saved_replies (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      shortcut              text NOT NULL,
      title                 text NOT NULL,
      content               text NOT NULL,
      created_by_agent_id   text,
      is_global             boolean NOT NULL DEFAULT true,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT omni_saved_replies_workspace_shortcut_unique
        UNIQUE (workspace_owner_id, shortcut)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_saved_replies_workspace
      ON omni_saved_replies (workspace_owner_id);
  `);
  logger.info("omni_saved_replies table ready");

  // omni_conversation_tags — tag assignments to conversations
  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_conversation_tags (
      id               serial PRIMARY KEY,
      conversation_id  integer NOT NULL REFERENCES omni_conversations(id) ON DELETE CASCADE,
      tag_id           integer NOT NULL REFERENCES omni_tags(id) ON DELETE CASCADE,
      created_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT omni_conversation_tags_unique UNIQUE (conversation_id, tag_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_conversation_tags_conversation
      ON omni_conversation_tags (conversation_id);
  `);
  logger.info("omni_conversation_tags table ready");

  // omni_contact_tags — tag assignments to contacts
  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_contact_tags (
      id          serial PRIMARY KEY,
      contact_id  integer NOT NULL REFERENCES omni_contacts(id) ON DELETE CASCADE,
      tag_id      integer NOT NULL REFERENCES omni_tags(id) ON DELETE CASCADE,
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT omni_contact_tags_unique UNIQUE (contact_id, tag_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_contact_tags_contact
      ON omni_contact_tags (contact_id);
  `);
  logger.info("omni_contact_tags table ready");

  // omni_automation_events — individual step events within an automation execution
  await db.query(`
    CREATE TABLE IF NOT EXISTS omni_automation_events (
      id            serial PRIMARY KEY,
      execution_id  uuid NOT NULL REFERENCES omni_automation_executions(id) ON DELETE CASCADE,
      node_id       text NOT NULL,
      node_type     text NOT NULL,
      status        text NOT NULL,
      input_data    jsonb,
      output_data   jsonb,
      error_message text,
      occurred_at   timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_omni_automation_events_execution
      ON omni_automation_events (execution_id);
  `);
  logger.info("omni_automation_events table ready");

  // ---------------------------------------------------------------------------
  // Contacts & Orders — native Presentail OS order ingestion tables
  // ---------------------------------------------------------------------------

  await db.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id    text NOT NULL,
      source                text,
      external_contact_id   text,
      account_id            text,
      is_guest              boolean NOT NULL DEFAULT true,
      first_name            text,
      last_name             text,
      display_name          text,
      email                 text,
      phone                 text,
      tags                  text[] NOT NULL DEFAULT '{}'::text[],
      addresses             jsonb,
      metadata              jsonb,
      archived_at           timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
  `);
  // Tracks every auto tag the tagging engine has ever applied to the contact
  // (vip / corporate / one-time / regular). A tag in this set is never
  // auto-added again, so user removals stick. See lib/autoTags.ts.
  await db.query(`
    ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS auto_tags_applied text[] NOT NULL DEFAULT '{}'::text[];
  `);
  // AI gender inference: probabilistic personalization signal, never a
  // definitive claim. gender is three-state with 'unknown' as safe default;
  // gender_source tracks who set it (ai | manual | imported) — manual wins.
  await db.query(`
    ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS gender text NOT NULL DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS gender_source text,
      ADD COLUMN IF NOT EXISTS gender_confidence numeric,
      ADD COLUMN IF NOT EXISTS gender_context_country text,
      ADD COLUMN IF NOT EXISTS gender_inferred_at timestamptz,
      ADD COLUMN IF NOT EXISTS gender_model_version text;
  `);
  // Cache of AI gender-inference results keyed by normalized first name +
  // country context + language + prompt/model version, so repeat names never
  // re-call the AI (ambiguous/unknown results are cached too).
  await db.query(`
    CREATE TABLE IF NOT EXISTS gender_inference_cache (
      id                    bigserial PRIMARY KEY,
      normalized_first_name text NOT NULL,
      country_context       text NOT NULL DEFAULT '',
      language              text NOT NULL DEFAULT '',
      prompt_version        text NOT NULL,
      gender                text NOT NULL,
      confidence            numeric,
      created_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS gender_inference_cache_key_unique
      ON gender_inference_cache (normalized_first_name, country_context, language, prompt_version);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_contacts_workspace
      ON contacts(workspace_owner_id);
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_source_external_unique
      ON contacts(workspace_owner_id, source, external_contact_id)
      WHERE source IS NOT NULL AND external_contact_id IS NOT NULL;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_email_unique
      ON contacts(workspace_owner_id, email)
      WHERE email IS NOT NULL;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_workspace_phone_unique
      ON contacts(workspace_owner_id, phone)
      WHERE phone IS NOT NULL;
  `);
  logger.info("contacts table ready");

  // ── phone_search_tokens column + backfill ─────────────────────────────────
  // Stores multiple digit-only token forms for each stored phone number so the
  // wizard search can match local formats (e.g. "03257") against E.164 stored
  // numbers (e.g. "+9613257533"). Populated by the runtime on insert/update;
  // existing rows are backfilled here on startup.
  await db.query(`
    ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS phone_search_tokens text[];
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_contacts_phone_search_tokens
      ON contacts USING GIN (phone_search_tokens)
      WHERE phone_search_tokens IS NOT NULL;
  `);
  // Pure-SQL backfill: for contacts that have a phone but no tokens yet,
  // derive the three digit-only forms using regexp_replace. This approximates
  // the Node buildPhoneSearchTokens logic for the most common cases:
  //   - Full stripped digits (e.g. "9613257533" from "+9613257533")
  //   - Stripped digits without first 1-3 digit country code (national significant)
  //   - Domestic form with leading "0" added
  // The runtime will overwrite with the precise libphonenumber-js tokens on the
  // next update; this backfill is just a best-effort seed so search works
  // immediately after deployment without requiring any data modification.
  //
  // NOTE: the 3-digit CC conditions use `>= 10` (not `> 10`). Lebanon (+961)
  // numbers strip to exactly 10 digits (3-digit CC + 7-digit NSN) and the old
  // `> 10` guard incorrectly excluded them from getting the NSN / domestic-0
  // tokens, causing "03257553" queries to miss "+9613257553" contacts.
  await db.query(`
    UPDATE contacts
       SET phone_search_tokens = ARRAY(
             SELECT DISTINCT t FROM unnest(ARRAY[
               -- Full stripped digits (removes + and non-digits)
               regexp_replace(phone, '[^0-9]', '', 'g'),
               -- Attempt to strip a 1-digit country code (e.g. "1" for US)
               CASE WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) > 8
                    THEN substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 2)
                    ELSE NULL
               END,
               -- Attempt to strip a 2-digit country code (e.g. "91" for IN, "44" for UK)
               CASE WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) > 9
                    THEN substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 3)
                    ELSE NULL
               END,
               -- Attempt to strip a 3-digit country code (e.g. "961" for LB, "971" for AE)
               -- Use >= 10 so exactly-10-digit numbers are included (3-digit CC + 7-digit NSN).
               CASE WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
                    THEN substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 4)
                    ELSE NULL
               END,
               -- Domestic forms with leading "0"
               CASE WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) > 8
                    THEN '0' || substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 2)
                    ELSE NULL
               END,
               CASE WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) > 9
                    THEN '0' || substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 3)
                    ELSE NULL
               END,
               -- Use >= 10 so Lebanese domestic forms like "03257553" are generated.
               CASE WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
                    THEN '0' || substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 4)
                    ELSE NULL
               END
             ]) AS t
             WHERE t IS NOT NULL AND length(t) >= 4
           )
     WHERE phone IS NOT NULL
       AND phone_search_tokens IS NULL;
  `);

  // ── Repair mis-backfilled Lebanese / 3-digit-CC contacts ──────────────────
  // The original backfill used `> 10` which silently excluded 10-digit stripped
  // numbers (Lebanon +961: 3-digit CC + 7-digit NSN = exactly 10 digits). Those
  // contacts already have phone_search_tokens set (so the IS NULL guard above
  // skips them) but are missing the NSN ("3257553") and domestic ("03257553")
  // tokens. Append the missing tokens idempotently without overwriting anything.
  await db.query(`
    UPDATE contacts
       SET phone_search_tokens = ARRAY(
             SELECT DISTINCT t
               FROM unnest(
                 phone_search_tokens ||
                 ARRAY[
                   substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 4),
                   '0' || substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 4)
                 ]
               ) AS t
              WHERE t IS NOT NULL AND length(t) >= 4
           )
     WHERE phone IS NOT NULL
       AND phone_search_tokens IS NOT NULL
       AND length(regexp_replace(phone, '[^0-9]', '', 'g')) = 10
       AND NOT (phone_search_tokens &&
             ARRAY['0' || substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 4)]);
  `);

  logger.info("contacts.phone_search_tokens column and backfill ready");

  // Legacy ManyChat subscriber ID — the ManyChat integration was replaced by
  // respond.io; the column stays (unused) to avoid a destructive publish
  // migration.
  await db.query(`
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS manychat_subscriber_id text;
  `);
  // respond.io contact ID — stores the numeric respond.io contact id so
  // subsequent upserts know not to re-sync the same contact.
  await db.query(`
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS respondio_contact_id text;
  `);
  // respond.io sync status — records the last sync outcome for contacts that
  // failed or have not yet been synced. Values: 'phone_format_invalid',
  // 'provider_unavailable', 'synced'. NULL means not yet attempted.
  await db.query(`
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS respondio_sync_status text;
  `);
  // One-time idempotent cleanup (legacy ManyChat era): reset any rows where
  // the sentinel string "phone_format_invalid" was incorrectly stored as the
  // subscriber ID.
  const manychatSentinelCleanup = await db.query(`
    UPDATE contacts
       SET manychat_subscriber_id = NULL
     WHERE manychat_subscriber_id = 'phone_format_invalid'
  `);
  if (manychatSentinelCleanup.rowCount && manychatSentinelCleanup.rowCount > 0) {
    logger.info(
      { cleaned: manychatSentinelCleanup.rowCount },
      "manychat sentinel cleanup: reset phone_format_invalid subscriber IDs to NULL",
    );
  }

  // ── Auto-tag backfill ──────────────────────────────────────────────────────
  // Set-based, idempotent backfill of the automatic contact tags
  // (vip / corporate / one-time / regular) for existing contacts. Mirrors the
  // runtime rules in lib/autoTags.ts (shared regex/domain constants). A tag is
  // only added when it is in neither `tags` nor `auto_tags_applied`, so user
  // removals stick and reruns are no-ops.
  //
  // Guard: this block runs before the orders/order_contacts/order_payment
  // sections below, so on a brand-new database those tables don't exist yet.
  // Skip the backfill then — a fresh DB has no contacts to backfill anyway,
  // and every later startup runs it once the tables are in place.
  const orderTablesReady = await db.query<{ ok: boolean }>(
    `SELECT (to_regclass('order_contacts') IS NOT NULL
         AND to_regclass('order_payment') IS NOT NULL
         AND to_regclass('orders') IS NOT NULL) AS ok`,
  );
  if (!orderTablesReady.rows[0]?.ok) {
    logger.info("contacts auto-tag backfill skipped: order tables not created yet (fresh DB)");
  } else {
  await db.query(
    `
    WITH stats AS (
      SELECT c.id,
             c.tags,
             c.auto_tags_applied,
             (SELECT COUNT(*) FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
               WHERE oc.contact_id = c.id AND oc.role = 'customer'
                 AND o.workspace_owner_id = c.workspace_owner_id)::int AS customer_orders,
             (SELECT COALESCE(SUM(op.amount_usd), 0)
                FROM order_contacts oc JOIN orders o ON o.id = oc.order_id
                JOIN order_payment op ON op.order_id = o.id
               WHERE oc.contact_id = c.id AND oc.role = 'customer'
                 AND o.workspace_owner_id = c.workspace_owner_id
                 AND lower(COALESCE(op.status, '')) IN ('paid', 'recorded')
                 AND op.amount_usd IS NOT NULL) AS total_spent_usd,
             (
               (c.email IS NOT NULL AND position('@' in c.email) > 0
                 AND lower(split_part(c.email, '@', 2)) <> ALL($2::text[])
                 AND position('.' in split_part(c.email, '@', 2)) > 0)
               OR concat_ws(' ', c.first_name, c.last_name, c.display_name, c.addresses::text) ~* $3
             ) AS corporate_signal
        FROM contacts c
    ),
    desired AS (
      SELECT id, tags, auto_tags_applied,
             ARRAY(
               SELECT t FROM unnest(ARRAY[
                 CASE WHEN customer_orders > 0 AND total_spent_usd > $1 THEN 'vip' END,
                 CASE WHEN customer_orders > 0 AND corporate_signal THEN 'corporate' END,
                 CASE WHEN customer_orders = 1 THEN 'one-time' END,
                 CASE WHEN customer_orders >= 2 THEN 'regular' END
               ]) AS t
                WHERE t IS NOT NULL
                  AND NOT (t = ANY(SELECT lower(x) FROM unnest(tags) x))
                  AND NOT (t = ANY(SELECT lower(x) FROM unnest(auto_tags_applied) x))
             ) AS to_add
        FROM stats
    )
    UPDATE contacts c
       SET tags = c.tags || d.to_add,
           auto_tags_applied = c.auto_tags_applied || d.to_add,
           updated_at = now()
      FROM desired d
     WHERE c.id = d.id AND cardinality(d.to_add) > 0
    `,
    [VIP_SPEND_THRESHOLD_USD, Array.from(FREE_EMAIL_DOMAINS), CORPORATE_KEYWORD_POSIX_RE],
  );
  logger.info("contacts auto-tag backfill complete");
  }

  // contact_notes — manual notes attached to a contact by workspace members
  await db.query(`
    CREATE TABLE IF NOT EXISTS contact_notes (
      id                  bigserial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      author_user_id      text,
      author_name         text,
      body                text NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_contact_notes_contact
      ON contact_notes(contact_id, created_at);
  `);
  logger.info("contact_notes table ready");

  // contact_activity — append-only system activity log for a contact
  await db.query(`
    CREATE TABLE IF NOT EXISTS contact_activity (
      id                  bigserial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type                text NOT NULL,
      actor_user_id       text,
      actor_name          text,
      data                jsonb,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_contact_activity_contact
      ON contact_activity(contact_id, created_at);
  `);
  logger.info("contact_activity table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id    text NOT NULL,
      source                text NOT NULL DEFAULT 'manual',
      external_order_id     text,
      external_order_number text,
      idempotency_key       text,
      order_number          text,
      display_order_number  text,
      status                text NOT NULL DEFAULT 'pending',
      channel               text,
      location_id           integer REFERENCES locations(id) ON DELETE SET NULL,
      customer_id           integer REFERENCES customers(id) ON DELETE SET NULL,
      ordered_at            timestamptz,
      delivery_type         text,
      delivery_date         date,
      delivery_address_status text,
      delivery_address      jsonb,
      delivery_instructions text,
      window_start          timestamptz,
      window_end            timestamptz,
      totals                jsonb,
      raw_payload           jsonb,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_workspace
      ON orders(workspace_owner_id, ordered_at DESC);
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_workspace_source_ext
      ON orders(workspace_owner_id, source, external_order_id)
      WHERE external_order_id IS NOT NULL;
  `);
  logger.info("orders table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_card_messages (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id text NOT NULL,
      order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      card_to            text,
      card_message       text NOT NULL,
      card_from          text,
      qr_link            text,
      created_by         text,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_order_card_messages_order
      ON order_card_messages(order_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_order_card_messages_workspace
      ON order_card_messages(workspace_owner_id);
  `);
  logger.info("order_card_messages table ready");

  // One-time, idempotent migration (July 2026): the "delivered" order status
  // was removed as a duplicate of "completed" — the lifecycle now ends at
  // completed. Any orders still in "delivered" are folded into "completed" so
  // both dev and prod are migrated on startup. Safe to re-run (no-op once no
  // rows match).
  {
    const migrated = await db.query(
      `UPDATE orders SET status = 'completed', updated_at = now() WHERE status = 'delivered'`,
    );
    if (migrated.rowCount && migrated.rowCount > 0) {
      logger.info(
        { migrated: migrated.rowCount },
        "orders status migration: folded 'delivered' orders into 'completed'",
      );
    }
  }

  // Uniqueness guard for manual order numbers (July 2026): the create path
  // and the backfill below both serialise on a per-workspace advisory lock,
  // but this partial unique index is the final DB-level guard — a duplicate
  // M- number in a workspace can never be committed. Safe to create up
  // front: M- numbers are introduced by this same release, so no
  // pre-existing rows can violate it.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_manual_number_unique
      ON orders (workspace_owner_id, display_order_number)
      WHERE display_order_number ~ '^M-[0-9]+$'
  `);
  logger.info("idx_orders_manual_number_unique index ready");

  // A retried CMC New Order request must return the original order instead of
  // collecting the same discounted payment twice.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_cmc_pos_idempotency
      ON orders (workspace_owner_id, (raw_payload->>'idempotency_key'))
      WHERE source = 'cmc-pos' AND raw_payload ? 'idempotency_key'
  `);

  // Idempotent backfill (July 2026): manually-created dashboard orders
  // historically had no display_order_number ("No number" in the orders
  // list). Assign each one the next number in its workspace's M- sequence
  // (M-1001, M-1002, …), oldest first, continuing after any M- numbers
  // already assigned (by the create path or a previous backfill run). Only
  // rows with a NULL display_order_number are ever touched, so re-running is
  // a no-op, and website-ingested orders (which always carry their own
  // number) are never affected. The initDb advisory lock prevents concurrent
  // backfills; to also serialise against LIVE manual creates on already-
  // running instances (rolling deploy window), the backfill runs in its own
  // transaction and takes the SAME per-workspace advisory xact lock the
  // create path uses (`manual_order_number:<workspace>`) for every affected
  // workspace BEFORE computing any numbers. In-flight creates commit first
  // and become visible to the MAX; later creates block until the backfill
  // commits — so numbers can never collide (and the unique index above is
  // the backstop).
  {
    const backfillClient = await db.connect();
    try {
      await backfillClient.query("BEGIN");
      const targetWorkspaces = await backfillClient.query<{ workspace_owner_id: string }>(
        `SELECT DISTINCT workspace_owner_id
           FROM orders
          WHERE display_order_number IS NULL
            AND (raw_payload->>'_source' = 'dashboard_manual' OR source = 'manual')
          ORDER BY workspace_owner_id`,
      );
      if (targetWorkspaces.rows.length > 0) {
        // Deterministic (sorted) lock order avoids deadlocks with any other
        // multi-workspace locker; the create path only ever takes one.
        for (const row of targetWorkspaces.rows) {
          await backfillClient.query(
            `SELECT pg_advisory_xact_lock(hashtextextended('manual_order_number:' || $1, 0))`,
            [row.workspace_owner_id],
          );
        }
        const backfilled = await backfillClient.query(
          `WITH existing_max AS (
             SELECT workspace_owner_id,
                    MAX((substring(display_order_number from '^M-([0-9]+)$'))::bigint) AS max_n
               FROM orders
              WHERE display_order_number ~ '^M-[0-9]+$'
              GROUP BY workspace_owner_id
           ),
           targets AS (
             SELECT o.id,
                    o.workspace_owner_id,
                    ROW_NUMBER() OVER (
                      PARTITION BY o.workspace_owner_id
                      ORDER BY o.created_at, o.id
                    ) AS rn
               FROM orders o
              WHERE o.display_order_number IS NULL
                AND (o.raw_payload->>'_source' = 'dashboard_manual' OR o.source = 'manual')
           )
           UPDATE orders o
              SET display_order_number = 'M-' || (COALESCE(em.max_n, 1000) + t.rn)::text,
                  updated_at = now()
             FROM targets t
             LEFT JOIN existing_max em ON em.workspace_owner_id = t.workspace_owner_id
            WHERE o.id = t.id
              AND o.display_order_number IS NULL`,
        );
        if (backfilled.rowCount && backfilled.rowCount > 0) {
          logger.info(
            { backfilled: backfilled.rowCount, workspaces: targetWorkspaces.rows.length },
            "manual order number backfill: assigned M- numbers to manual orders without one",
          );
        }
      }
      await backfillClient.query("COMMIT");
    } catch (err) {
      await backfillClient.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      backfillClient.release();
    }
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_contacts (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      role        text NOT NULL DEFAULT 'customer',
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Historical re-ingestion could write the same role link repeatedly before
  // this index existed. Keep the oldest row, then make role links idempotent
  // for every creation and retry path.
  await db.query(`
    DELETE FROM order_contacts duplicate
     USING order_contacts keeper
     WHERE duplicate.order_id = keeper.order_id
       AND duplicate.contact_id = keeper.contact_id
       AND duplicate.role = keeper.role
       AND duplicate.id > keeper.id;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_order_contacts_order_contact_role
      ON order_contacts(order_id, contact_id, role);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_contacts_order
      ON order_contacts(order_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_contacts_contact
      ON order_contacts(contact_id);
  `);
  logger.info("order_contacts table ready");

  // Audit trail for manual edits to an order's customer / recipient contact
  // details (PATCH /orders/:id/contacts). One row per edit, append-only; the
  // order detail surfaces the latest row per role as "last edited by X at Y".
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_contact_edits (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id text NOT NULL,
      order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      role               text NOT NULL,
      edited_by_user_id  text NOT NULL,
      edited_by_name     text,
      edited_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_contact_edits_order_role
      ON order_contact_edits(order_id, role, edited_at);
  `);
  logger.info("order_contact_edits table ready");

  // Append-only order activity log (status changes, mark-paid, refunds,
  // internal notes). The order detail Activity timeline merges these rows with
  // synthesized events (order placed, payment paid_at, contact edits).
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_events (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id text NOT NULL,
      order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      event_type         text NOT NULL,
      payload            jsonb,
      actor_user_id      text,
      actor_name         text,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_events_order
      ON order_events(order_id, created_at);
  `);
  logger.info("order_events table ready");

  // Customer Communications tracking — one row per outgoing order email
  // attempt (best-effort around the send), plus an append-only ledger of
  // provider (Resend) delivery events. provider_event_id is unique when
  // present so duplicate webhook deliveries are ignored idempotently.
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_communications (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id   text NOT NULL,
      order_id             uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      template_type        text NOT NULL,
      channel              text NOT NULL DEFAULT 'email',
      recipient_role       text NOT NULL DEFAULT 'customer',
      recipient_name       text,
      recipient_email      text,
      subject              text,
      provider             text NOT NULL DEFAULT 'resend',
      provider_message_id  text,
      status               text NOT NULL DEFAULT 'not_sent',
      attempt              integer NOT NULL DEFAULT 1,
      failure_reason       text,
      triggered_by_user_id text,
      triggered_by_name    text,
      sent_at              timestamptz,
      delivered_at         timestamptz,
      opened_at            timestamptz,
      clicked_at           timestamptz,
      last_event_at        timestamptz,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_communications_order
      ON order_communications(order_id, created_at);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_communications_provider_msg
      ON order_communications(provider_message_id);
  `);
  await db.query(`
    ALTER TABLE order_communications
      ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email',
      ADD COLUMN IF NOT EXISTS recipient_phone text,
      ADD COLUMN IF NOT EXISTS template_name text,
      ADD COLUMN IF NOT EXISTS idempotency_key text;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_order_communications_idempotency
      ON order_communications(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_reschedule_jobs (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id              uuid NOT NULL UNIQUE REFERENCES order_events(id) ON DELETE CASCADE,
      workspace_owner_id    text NOT NULL,
      order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      order_number          text NOT NULL,
      tookan_job_id         text,
      window_start          timestamptz,
      window_end            timestamptz,
      tookan_address_payload jsonb,
      is_reschedule         boolean NOT NULL DEFAULT true,
      planning_completed_at timestamptz,
      tookan_completed_at   timestamptz,
      notification_completed_at timestamptz,
      status                text NOT NULL DEFAULT 'pending',
      attempts              integer NOT NULL DEFAULT 0,
      next_attempt_at       timestamptz NOT NULL DEFAULT now(),
      locked_at             timestamptz,
      last_error            text,
      completed_at          timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    ALTER TABLE order_reschedule_jobs
      ALTER COLUMN window_start DROP NOT NULL,
      ALTER COLUMN window_end DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS tookan_address_payload jsonb,
      ADD COLUMN IF NOT EXISTS is_reschedule boolean NOT NULL DEFAULT true;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_order_reschedule_jobs_event
      ON order_reschedule_jobs(event_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_reschedule_jobs_pending
      ON order_reschedule_jobs(next_attempt_at, created_at)
      WHERE status IN ('pending', 'processing');
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_communication_events (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      communication_id  uuid NOT NULL REFERENCES order_communications(id) ON DELETE CASCADE,
      provider_event_id text,
      event_type        text NOT NULL,
      raw_type          text,
      occurred_at       timestamptz,
      payload           jsonb,
      created_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_comm_events_comm
      ON order_communication_events(communication_id, created_at);
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_order_comm_events_provider_event
      ON order_communication_events(provider_event_id)
      WHERE provider_event_id IS NOT NULL;
  `);
  logger.info("order_communications tables ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_line_items (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id  integer,
      external_id text,
      name        text NOT NULL,
      sku         text,
      quantity    numeric NOT NULL DEFAULT 1,
      unit_price  numeric,
      line_total  numeric,
      metadata    jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_line_items_order
      ON order_line_items(order_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_line_items_product
      ON order_line_items(product_id)
      WHERE product_id IS NOT NULL;
  `);
  // Per-line product thumbnail. Present in the Drizzle schema (dev) but omitted
  // from the original CREATE TABLE above, so production DBs lacked it and the
  // GET /api/orders list query (which selects image_url) 500'd. Idempotent ALTER
  // backfills the column on existing deployments.
  await db.query(`
    ALTER TABLE order_line_items
      ADD COLUMN IF NOT EXISTS image_url text;
  `);
  // Per-line customer personalization typed into the storefront input field
  // (capped at 22 chars on ingest). Nullable; present in the Drizzle schema.
  await db.query(`
    ALTER TABLE order_line_items
      ADD COLUMN IF NOT EXISTS custom_input text;
  `);
  // Actual charged per-item price in the customer's paid currency (the
  // storefront rounds display prices to the nearest 0/5/10 and charges the
  // rounded amount). Nullable; sent by the website on ingest. The paid
  // currency lives in orders.totals.paid_currency.
  await db.query(`
    ALTER TABLE order_line_items
      ADD COLUMN IF NOT EXISTS paid_unit_price numeric,
      ADD COLUMN IF NOT EXISTS paid_line_total numeric;
  `);
  // Custom (one-off) items created by agents in the dashboard wizard.
  await db.query(`
    ALTER TABLE order_line_items
      ADD COLUMN IF NOT EXISTS is_custom_item boolean NOT NULL DEFAULT false;
  `);
  await db.query(`
    ALTER TABLE order_line_items
      ADD COLUMN IF NOT EXISTS production_instructions text;
  `);
  await db.query(`
    ALTER TABLE order_line_items
      ADD COLUMN IF NOT EXISTS custom_item_created_by text;
  `);
  // Complimentary (free) line items: added by staff as a $0 customer-service
  // gesture. is_complimentary flags the line; complimentary_original_price
  // preserves the immutable per-unit catalog price captured at add time (used
  // to compute the Merchandise subtotal / Complimentary item(s) totals rows);
  // reason/note/added_by/added_at back the audit trail alongside the
  // order_events row recorded by the add-line-item route.
  await db.query(`
    ALTER TABLE order_line_items
      ADD COLUMN IF NOT EXISTS is_complimentary boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS complimentary_original_price numeric(14,4),
      ADD COLUMN IF NOT EXISTS complimentary_reason text,
      ADD COLUMN IF NOT EXISTS complimentary_note text,
      ADD COLUMN IF NOT EXISTS complimentary_added_by text,
      ADD COLUMN IF NOT EXISTS complimentary_added_at timestamptz;
  `);
  logger.info("order_line_items table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_payment (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id        uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      provider        text,
      provider_ref    text,
      method          text,
      amount_cents    integer,
      currency        text,
      status          text NOT NULL DEFAULT 'pending',
      paid_at         timestamptz,
      metadata        jsonb,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    ALTER TABLE order_payment
      ADD COLUMN IF NOT EXISTS amount_usd numeric(10,2);
  `);
  // The amount actually charged in `currency` (paid-currency amount), so the
  // (currency, amount) pair is always consistent; amount_usd stays the USD
  // equivalent.
  await db.query(`
    ALTER TABLE order_payment
      ADD COLUMN IF NOT EXISTS amount numeric(14,4);
  `);
  // Cumulative refunded amounts (paid currency + USD equivalent) so partial
  // refunds can accumulate toward the full paid total.
  await db.query(`
    ALTER TABLE order_payment
      ADD COLUMN IF NOT EXISTS refunded_amount numeric(14,4);
  `);
  await db.query(`
    ALTER TABLE order_payment
      ADD COLUMN IF NOT EXISTS refunded_amount_usd numeric(14,4);
  `);
  // Whish payment-instruction delivery is an order-level, idempotent
  // communication. The immutable claim token makes every finalization belong
  // to the attempt that earned the claim, preventing stale workers from
  // overwriting a newer attempt's state.
  await db.query(`
    ALTER TABLE order_payment
      ADD COLUMN IF NOT EXISTS whish_instructions_sent_at timestamptz,
      ADD COLUMN IF NOT EXISTS whish_instructions_provider_ref text,
      ADD COLUMN IF NOT EXISTS whish_instructions_status text NOT NULL DEFAULT 'not_sent',
      ADD COLUMN IF NOT EXISTS whish_instructions_failure_reason text,
      ADD COLUMN IF NOT EXISTS whish_instructions_claimed_at timestamptz,
      ADD COLUMN IF NOT EXISTS whish_instructions_claim_token uuid;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_payment_order
      ON order_payment(order_id);
  `);
  logger.info("order_payment table ready");

  // The drizzle schema and all app code (GET /orders/:id, externalOrders
  // upsert, PATCH /orders/:id) model order_notes as a single row per order with
  // four nullable text columns. An earlier legacy design used note_type/body
  // rows instead, which is incompatible. Drop the legacy table if detected
  // (safe — no orders exist) so the canonical four-column design is recreated.
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'order_notes' AND column_name = 'body'
      ) THEN
        DROP TABLE order_notes CASCADE;
      END IF;
    END $$;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_notes (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      customer_note text,
      florist_note  text,
      driver_note   text,
      internal_note text
    );
  `);
  // Defensive guard: ensure the canonical note columns always exist even if the
  // legacy drop-and-recreate path above is ever removed or the table predates
  // them. The external-order card-note insert writes customer_note, and the
  // PATCH /orders/:id handler writes all four; a missing column would otherwise
  // surface as a silent side-effect failure.
  await db.query(`
    ALTER TABLE order_notes ADD COLUMN IF NOT EXISTS customer_note text;
  `);
  await db.query(`
    ALTER TABLE order_notes ADD COLUMN IF NOT EXISTS florist_note text;
  `);
  await db.query(`
    ALTER TABLE order_notes ADD COLUMN IF NOT EXISTS internal_note text;
  `);
  // Unique on order_id so PATCH/insert can upsert with ON CONFLICT (order_id).
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_order_notes_order
      ON order_notes(order_id);
  `);
  logger.info("order_notes table ready");

  // Add order_id UUID column to fleet_driver_order_assignments (native orders FK).
  await db.query(`
    ALTER TABLE fleet_driver_order_assignments
      ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_fdoa_order_id
      ON fleet_driver_order_assignments(order_id)
      WHERE order_id IS NOT NULL;
  `);
  logger.info("fleet_driver_order_assignments.order_id column ready");

  // ── Publishing Channels ────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS publishing_channels (
      id               serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      name             text NOT NULL,
      slug             text NOT NULL,
      type             text NOT NULL DEFAULT 'website',
      brand_id         integer,
      status           text NOT NULL DEFAULT 'active',
      default_currency text NOT NULL DEFAULT 'USD',
      auto_publish_new_products boolean NOT NULL DEFAULT false,
      allowed_origins  text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publishing_channels_workspace_slug
      ON publishing_channels(workspace_owner_id, slug);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_publishing_channels_workspace
      ON publishing_channels(workspace_owner_id);
  `);
  logger.info("publishing_channels table ready");

  // ── Product Publications ────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS product_publications (
      id                   serial PRIMARY KEY,
      workspace_owner_id   text NOT NULL,
      product_id           integer NOT NULL,
      channel_id           integer NOT NULL REFERENCES publishing_channels(id) ON DELETE CASCADE,
      publication_status   text NOT NULL DEFAULT 'draft',
      is_visible           boolean NOT NULL DEFAULT true,
      published_at         timestamptz,
      unpublished_at       timestamptz,
      scheduled_publish_at timestamptz,
      scheduled_unpublish_at timestamptz,
      last_synced_at       timestamptz,
      sync_status          text NOT NULL DEFAULT 'never_synced',
      sync_error           text,
      public_slug          text,
      public_title         text,
      short_description    text,
      long_description     text,
      seo_title            text,
      seo_description      text,
      og_image_url         text,
      featured             boolean NOT NULL DEFAULT false,
      sort_order           integer,
      badges               jsonb NOT NULL DEFAULT '[]'::jsonb,
      extra_fields         jsonb NOT NULL DEFAULT '{}'::jsonb,
      price_override       numeric(10,2),
      sale_price_override  numeric(10,2),
      currency_override    text,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE(product_id, channel_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_product_publications_product
      ON product_publications(product_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_product_publications_channel
      ON product_publications(channel_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_product_publications_workspace
      ON product_publications(workspace_owner_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_product_publications_status
      ON product_publications(channel_id, publication_status, is_visible);
  `);
  logger.info("product_publications table ready");

  // ── Catalog API Keys ────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS catalog_api_keys (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      name               text NOT NULL,
      key_hash           text NOT NULL,
      key_prefix         text NOT NULL,
      channel_id         integer REFERENCES publishing_channels(id) ON DELETE SET NULL,
      status             text NOT NULL DEFAULT 'active',
      created_at         timestamptz NOT NULL DEFAULT now(),
      last_used_at       timestamptz,
      revoked_at         timestamptz
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_api_keys_hash
      ON catalog_api_keys(key_hash);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_catalog_api_keys_workspace
      ON catalog_api_keys(workspace_owner_id);
  `);
  logger.info("catalog_api_keys table ready");

  // ── Product Sync Logs ───────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS product_sync_logs (
      id            serial PRIMARY KEY,
      product_id    integer NOT NULL,
      channel_id    integer NOT NULL,
      event_type    text NOT NULL,
      changed_fields jsonb,
      status        text NOT NULL DEFAULT 'ok',
      message       text,
      metadata      jsonb,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_product_sync_logs_product
      ON product_sync_logs(product_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_product_sync_logs_channel
      ON product_sync_logs(channel_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_product_sync_logs_created
      ON product_sync_logs(created_at);
  `);
  logger.info("product_sync_logs table ready");

  // ── Channel Webhook Endpoints ───────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS channel_webhook_endpoints (
      id                   serial PRIMARY KEY,
      channel_id           integer NOT NULL REFERENCES publishing_channels(id) ON DELETE CASCADE,
      workspace_owner_id   text NOT NULL,
      name                 text NOT NULL,
      endpoint_url         text NOT NULL,
      signing_secret       text NOT NULL,
      subscribed_events    jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_active            boolean NOT NULL DEFAULT true,
      last_delivery_status text,
      last_delivery_at     timestamptz,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_channel_webhook_endpoints_channel
      ON channel_webhook_endpoints(channel_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_channel_webhook_endpoints_workspace
      ON channel_webhook_endpoints(workspace_owner_id);
  `);
  logger.info("channel_webhook_endpoints table ready");

  // ── Product Webhook Deliveries ──────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS product_webhook_deliveries (
      id                          text PRIMARY KEY,
      channel_webhook_endpoint_id integer NOT NULL REFERENCES channel_webhook_endpoints(id) ON DELETE CASCADE,
      event                       text NOT NULL,
      payload                     jsonb NOT NULL,
      status                      text NOT NULL DEFAULT 'pending',
      response_status             integer,
      response_body               text,
      attempt_count               integer NOT NULL DEFAULT 0,
      next_retry_at               timestamptz,
      duration_ms                 integer,
      created_at                  timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE product_webhook_deliveries ADD COLUMN IF NOT EXISTS duration_ms integer;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_product_webhook_deliveries_endpoint
      ON product_webhook_deliveries(channel_webhook_endpoint_id);
  `);
  logger.info("product_webhook_deliveries table ready");

  // ── Seed "Presentail Website & App" publishing channel ─────────────────────
  // For each workspace that has a "Presentail Flowers & Gifts" brand, create
  // the default channel if it doesn't already exist.
  await db.query(`
    DO $$
    DECLARE
      owner_id text;
      brand_row record;
      channel_id integer;
    BEGIN
      FOR brand_row IN
        SELECT DISTINCT workspace_owner_id, id AS brand_id
          FROM brands
         WHERE lower(name) = lower('Presentail Flowers & Gifts')
      LOOP
        owner_id := brand_row.workspace_owner_id;
        INSERT INTO publishing_channels
          (workspace_owner_id, name, slug, type, brand_id, status, default_currency, auto_publish_new_products)
        VALUES
          (owner_id, 'Presentail Website & App', 'presentail-website-app', 'website',
           brand_row.brand_id, 'active', 'USD', false)
        ON CONFLICT (workspace_owner_id, slug) DO NOTHING;
      END LOOP;

      -- Fallback: create a channel for any workspace that has no channel yet
      FOR owner_id IN
        SELECT DISTINCT workspace_owner_id FROM workspace_members WHERE role = 'owner'
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM publishing_channels WHERE workspace_owner_id = owner_id
        ) THEN
          INSERT INTO publishing_channels
            (workspace_owner_id, name, slug, type, status, default_currency, auto_publish_new_products)
          VALUES
            (owner_id, 'Presentail Website & App', 'presentail-website-app', 'website', 'active', 'USD', false)
          ON CONFLICT (workspace_owner_id, slug) DO NOTHING;
        END IF;
      END LOOP;
    END $$;
  `);
  logger.info("publishing_channels seed complete");

  // ── Backfill product_publications for Presentail Flowers & Gifts products ──
  await db.query(`
    DO $$
    DECLARE
      ch record;
      brand_name text;
    BEGIN
      FOR ch IN
        SELECT pc.id AS channel_id, pc.workspace_owner_id, b.name AS brand_name
          FROM publishing_channels pc
          JOIN brands b ON b.id = pc.brand_id
         WHERE pc.slug = 'presentail-website-app'
           AND pc.brand_id IS NOT NULL
      LOOP
        -- available → published + visible
        INSERT INTO product_publications
          (product_id, channel_id, workspace_owner_id, publication_status, is_visible, published_at, sync_status, last_synced_at)
        SELECT p.id, ch.channel_id, ch.workspace_owner_id, 'published', true, now(), 'synced', now()
          FROM products p
         WHERE p.workspace_owner_id = ch.workspace_owner_id
           AND lower(p.brand) = lower(ch.brand_name)
           AND p.status = 'available'
           AND p.is_archived = false
        ON CONFLICT (product_id, channel_id) DO NOTHING;

        -- out_of_stock or not_available → hidden
        INSERT INTO product_publications
          (product_id, channel_id, workspace_owner_id, publication_status, is_visible, sync_status)
        SELECT p.id, ch.channel_id, ch.workspace_owner_id, 'hidden', false, 'synced'
          FROM products p
         WHERE p.workspace_owner_id = ch.workspace_owner_id
           AND lower(p.brand) = lower(ch.brand_name)
           AND p.status IN ('out_of_stock', 'not_available')
           AND p.is_archived = false
        ON CONFLICT (product_id, channel_id) DO NOTHING;

        -- archived → archived status
        INSERT INTO product_publications
          (product_id, channel_id, workspace_owner_id, publication_status, is_visible, sync_status)
        SELECT p.id, ch.channel_id, ch.workspace_owner_id, 'archived', false, 'synced'
          FROM products p
         WHERE p.workspace_owner_id = ch.workspace_owner_id
           AND lower(p.brand) = lower(ch.brand_name)
           AND p.is_archived = true
        ON CONFLICT (product_id, channel_id) DO NOTHING;
      END LOOP;
    END $$;
  `);
  logger.info("product_publications backfill complete");

  // ── supplier_catalog_items — items in a supplier's catalog ──────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_catalog_items (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      supplier_id         integer     NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      base_item_id        integer,
      supplier_item_code  text,
      name                text        NOT NULL,
      category            text,
      unit                text,
      package_size        text,
      price               numeric(14,4),
      currency            text        NOT NULL DEFAULT 'AED',
      min_order_quantity  numeric(14,4) NOT NULL DEFAULT 1,
      par_level           numeric(14,4),
      current_stock       numeric(14,4),
      lead_time_days      integer,
      is_active           boolean     NOT NULL DEFAULT true,
      created_at          timestamptz DEFAULT now(),
      updated_at          timestamptz DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_supplier_catalog_items_supplier
      ON supplier_catalog_items(supplier_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_supplier_catalog_items_workspace
      ON supplier_catalog_items(workspace_owner_id);
  `);
  await db.query(`
    ALTER TABLE supplier_catalog_items
      ADD COLUMN IF NOT EXISTS name_ar text;
  `);
  await db.query(`
    ALTER TABLE supplier_catalog_items
      ADD COLUMN IF NOT EXISTS name_ar_source text;
  `);
  logger.info("supplier_catalog_items table ready");

  // ── supplier_catalog_item_stock_log — audit trail for stock/par edits ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_catalog_item_stock_log (
      id                      serial PRIMARY KEY,
      catalog_item_id         integer     NOT NULL REFERENCES supplier_catalog_items(id) ON DELETE CASCADE,
      workspace_owner_id      text        NOT NULL,
      field                   text        NOT NULL,
      old_value               numeric(14,4),
      new_value               numeric(14,4),
      changed_by_clerk_id     text,
      created_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sci_stock_log_item
      ON supplier_catalog_item_stock_log(catalog_item_id, created_at DESC);
  `);
  logger.info("supplier_catalog_item_stock_log table ready");

  // ── smoke_test_runs — persistent log of every smoke-test execution ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS smoke_test_runs (
      id          serial PRIMARY KEY,
      ran_at      timestamptz NOT NULL DEFAULT now(),
      base_url    text NOT NULL,
      passed      boolean NOT NULL,
      total       integer NOT NULL,
      passed_count integer NOT NULL,
      failed_count integer NOT NULL,
      checks      jsonb NOT NULL DEFAULT '[]'::jsonb,
      duration_ms integer
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_smoke_test_runs_ran_at
      ON smoke_test_runs(ran_at DESC);
  `);
  logger.info("smoke_test_runs table ready");

  // ── workspace_ingest_keys — per-workspace bearer tokens for /api/v1/ ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS workspace_ingest_keys (
      id                 serial PRIMARY KEY,
      workspace_owner_id text        NOT NULL UNIQUE,
      key_hash           text        NOT NULL,
      key_prefix         text        NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now(),
      last_used_at       timestamptz
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_ingest_keys_hash
      ON workspace_ingest_keys(key_hash);
  `);
  logger.info("workspace_ingest_keys table ready");

  // ── ingest_key_usage — per-endpoint daily call counts ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS ingest_key_usage (
      ingest_key_id integer     NOT NULL REFERENCES workspace_ingest_keys(id) ON DELETE CASCADE,
      endpoint      text        NOT NULL,
      usage_date    date        NOT NULL DEFAULT CURRENT_DATE,
      call_count    integer     NOT NULL DEFAULT 1,
      CONSTRAINT ingest_key_usage_pkey PRIMARY KEY (ingest_key_id, endpoint, usage_date)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ingest_key_usage_key_date
      ON ingest_key_usage(ingest_key_id, usage_date DESC);
  `);
  logger.info("ingest_key_usage table ready");

  // Fire-and-forget: prune ingest_key_usage rows older than the retention window.
  // Runs asynchronously so it never blocks server startup.
  db.query(
    `DELETE FROM ingest_key_usage WHERE usage_date < CURRENT_DATE - $1::integer`,
    [INGEST_USAGE_RETENTION_DAYS],
  ).then((result) => {
    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      logger.info(
        `ingest_key_usage prune: removed ${deleted} row(s) older than ${INGEST_USAGE_RETENTION_DAYS} days`,
      );
    } else {
      logger.info(
        `ingest_key_usage prune: no rows older than ${INGEST_USAGE_RETENTION_DAYS} days`,
      );
    }
  }).catch((err: unknown) => {
    logger.error({ err }, "ingest_key_usage prune: cleanup query failed");
  });

  // ── customers — extended website integration columns ─────────────────────
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS website_user_id text`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS date_of_birth date`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS gender text`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_opt_in boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS saved_addresses jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS customers_workspace_website_user_id_unique
      ON customers(workspace_owner_id, website_user_id)
      WHERE website_user_id IS NOT NULL AND deleted_at IS NULL;
  `);
  logger.info("customers extended columns ready");

  // ── orders — legacy v1 and express delivery/website integration columns ───
  // These nullable fields are part of the legacy v1 order contract. Keep the
  // ALTER block in addition to the CREATE TABLE definition so existing
  // databases receive the same columns as fresh databases.
  await db.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS external_order_number text,
      ADD COLUMN IF NOT EXISTS idempotency_key text,
      ADD COLUMN IF NOT EXISTS order_number text,
      ADD COLUMN IF NOT EXISTS delivery_date date,
      ADD COLUMN IF NOT EXISTS delivery_address_status text
  `);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS website_user_id text`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS express_delivery_selected boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS express_delivery_fee numeric(10,2)`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS card_message text`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS card_from text`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS card_to text`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_link text`);
  logger.info("orders express/website columns ready");

  // ── orders — retire the "confirmed" status ────────────────────────────────
  // "Confirmed" was removed from the order lifecycle. Migrate any existing
  // orders still marked 'confirmed' to 'processing' so nothing displays an
  // unknown status. Idempotent — once migrated, no rows match.
  {
    const migrated = await db.query(
      `UPDATE orders SET status = 'processing' WHERE status = 'confirmed'`,
    );
    if (migrated.rowCount && migrated.rowCount > 0) {
      logger.info(
        `orders status migration: moved ${migrated.rowCount} 'confirmed' order(s) to 'processing'`,
      );
    } else {
      logger.info("orders status migration: no 'confirmed' orders found");
    }
  }

  // ── delivery_cities — extended availability and slot-cap columns ──────────
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS standard_delivery_available boolean NOT NULL DEFAULT true`);
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS express_delivery_available boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS express_free_delivery_threshold numeric(10,2)`);
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS cutoff_time text`);
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS max_standard_orders_per_slot integer`);
  await db.query(`ALTER TABLE delivery_cities ADD COLUMN IF NOT EXISTS max_express_orders_per_slot integer`);
  logger.info("delivery_cities extended columns ready");

  // ── district_weekly_delivery_slots — delivery type and availability ───────
  await db.query(`ALTER TABLE district_weekly_delivery_slots ADD COLUMN IF NOT EXISTS delivery_type text NOT NULL DEFAULT 'standard'`);
  await db.query(`ALTER TABLE district_weekly_delivery_slots ADD COLUMN IF NOT EXISTS same_day_available boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE district_weekly_delivery_slots ADD COLUMN IF NOT EXISTS next_day_available boolean NOT NULL DEFAULT true`);
  logger.info("district_weekly_delivery_slots extended columns ready");

  await db.query(`ALTER TABLE district_special_date_override_slots ADD COLUMN IF NOT EXISTS delivery_type text NOT NULL DEFAULT 'standard'`);
  await db.query(`ALTER TABLE district_special_date_override_slots ADD COLUMN IF NOT EXISTS same_day_available boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE district_special_date_override_slots ADD COLUMN IF NOT EXISTS next_day_available boolean NOT NULL DEFAULT true`);
  logger.info("district_special_date_override_slots extended columns ready");

  // ── delivery_settings — global per-workspace delivery configuration ───────
  await db.query(`
    CREATE TABLE IF NOT EXISTS delivery_settings (
      workspace_owner_id              text PRIMARY KEY,
      standard_delivery_active        boolean NOT NULL DEFAULT true,
      express_delivery_active         boolean NOT NULL DEFAULT false,
      same_day_express_active         boolean NOT NULL DEFAULT false,
      global_standard_fee             numeric(10,2),
      global_express_fee              numeric(10,2),
      global_free_delivery_threshold  numeric(10,2),
      global_express_free_threshold   numeric(10,2),
      updated_at                      timestamptz NOT NULL DEFAULT now()
    );
  `);
  logger.info("delivery_settings table ready");

  // ── base_item_country_thresholds — owner-configured default low-stock
  //    threshold per country per base item. Individual location overrides
  //    take priority; this value is the fallback when the location row has
  //    low_stock_threshold = 0.
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_country_thresholds (
      id              serial PRIMARY KEY,
      base_item_id    integer NOT NULL REFERENCES base_items(id) ON DELETE CASCADE,
      country         text NOT NULL,
      default_low_stock_threshold numeric NOT NULL DEFAULT 0,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT base_item_country_thresholds_unique UNIQUE (base_item_id, country)
    );
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_item_country_thresholds'
            AND indexname  = 'idx_bict_base_item'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bict_base_item
         ON base_item_country_thresholds(base_item_id);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_bict_base_item: already present — no action needed");
    } else {
      logger.info("idx_bict_base_item: created");
    }
  }
  logger.info("base_item_country_thresholds table ready");

  // ── base_item_stock_transfers — records same-country stock movement
  //    between two locations. Two adjustment rows (one negative, one positive)
  //    are also inserted and linked via transfer_id.
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_stock_transfers (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      base_item_id        integer NOT NULL REFERENCES base_items(id) ON DELETE CASCADE,
      country             text NOT NULL,
      from_location_id    integer NOT NULL REFERENCES locations(id),
      to_location_id      integer NOT NULL REFERENCES locations(id),
      quantity            numeric NOT NULL,
      reason              text NOT NULL,
      note                text,
      performed_by_user_id text,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    ALTER TABLE base_item_stock_transfers
      ADD COLUMN IF NOT EXISTS workspace_owner_id text,
      ADD COLUMN IF NOT EXISTS idempotency_key uuid,
      ADD COLUMN IF NOT EXISTS payload_hash text
  `);
  await db.query(`
    UPDATE base_item_stock_transfers t
       SET workspace_owner_id = bi.workspace_owner_id
      FROM base_items bi
     WHERE t.workspace_owner_id IS NULL
       AND bi.id = t.base_item_id
  `);
  await db.query(`
    ALTER TABLE base_item_stock_transfers
      ALTER COLUMN workspace_owner_id SET NOT NULL
  `);
  await db.query(`DROP INDEX IF EXISTS idx_bist_base_item_action`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bist_workspace_action
      ON base_item_stock_transfers(workspace_owner_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'base_item_stock_transfers'
            AND indexname  = 'idx_bist_base_item'
       ) AS exists`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_bist_base_item
         ON base_item_stock_transfers(base_item_id, created_at DESC);`,
    );
    if (existsBefore.rows[0].exists) {
      logger.info("idx_bist_base_item: already present — no action needed");
    } else {
      logger.info("idx_bist_base_item: created");
    }
  }
  logger.info("base_item_stock_transfers table ready");

  // ── base_item_stock_adjustments extended columns (movement_type, transfer_id)
  await db.query(`
    ALTER TABLE base_item_stock_adjustments
      ADD COLUMN IF NOT EXISTS movement_type text,
      ADD COLUMN IF NOT EXISTS transfer_id   integer REFERENCES base_item_stock_transfers(id) ON DELETE SET NULL;
  `);
  logger.info("base_item_stock_adjustments movement_type/transfer_id columns ready");

  // ── tax_rules — workspace-level location-based tax rate table ─────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS tax_rules (
      id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id text        NOT NULL,
      country_code       text        NOT NULL,
      location_id        integer     REFERENCES locations(id) ON DELETE SET NULL,
      tax_category       text        NOT NULL,
      rate_percent       numeric(6,4) NOT NULL,
      effective_from     date        NOT NULL DEFAULT CURRENT_DATE,
      effective_to       date,
      is_active          boolean     NOT NULL DEFAULT true,
      description        text,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_rules_unique_rule
      ON tax_rules(workspace_owner_id, country_code, COALESCE(location_id::text, ''), tax_category, effective_from);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_tax_rules_workspace
      ON tax_rules(workspace_owner_id, is_active, country_code, tax_category);
  `);
  logger.info("tax_rules table ready");

  // ── base_items — add tax_category column ──────────────────────────────────
  await db.query(`ALTER TABLE base_items ADD COLUMN IF NOT EXISTS tax_category text NOT NULL DEFAULT 'not_classified'`);
  logger.info("base_items.tax_category column ready");

  // ── suppliers — add VAT / purchasing defaults ──────────────────────────────
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS vat_number text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_vat_treatment text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_currency text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_payment_terms text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_tax_category text`);
  logger.info("suppliers VAT/default columns ready");

  // ── suppliers — add catalog/profile columns referenced by routes ───────────
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS category text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS vat_registered boolean DEFAULT false`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS billing_address text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS website text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tags text`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_vat_rate numeric`);
  logger.info("suppliers missing columns ready");

  // ── purchase_orders — add VAT treatment columns ───────────────────────────
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vat_treatment text`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS tax_override_reason text`);
  // Cost-summary / VAT / metadata columns written by the POST/PATCH routes.
  // Added idempotently so existing production tables gain them on startup.
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS subtotal_amount numeric(14,4)`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS discount_amount numeric(14,4)`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_fee_amount numeric(14,4)`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vat_rate numeric(6,3)`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vat_amount numeric(14,4)`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vat_manual_override boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vat_override_reason text`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS grand_total_amount numeric(14,4)`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS payment_terms text`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_reference text`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS attachment_urls text`);
  logger.info("purchase_orders VAT columns ready");

  // ── purchase_order_line_items — add per-line tax columns ──────────────────
  await db.query(`ALTER TABLE purchase_order_line_items ADD COLUMN IF NOT EXISTS tax_category text`);
  await db.query(`ALTER TABLE purchase_order_line_items ADD COLUMN IF NOT EXISTS applied_tax_rate numeric(6,4)`);
  await db.query(`ALTER TABLE purchase_order_line_items ADD COLUMN IF NOT EXISTS taxable_amount numeric(12,2)`);
  await db.query(`ALTER TABLE purchase_order_line_items ADD COLUMN IF NOT EXISTS tax_amount numeric(12,2)`);
  await db.query(`ALTER TABLE purchase_order_line_items ADD COLUMN IF NOT EXISTS vat_treatment text`);
  logger.info("purchase_order_line_items tax columns ready");

  // ── low_stock_alert_notifications — dedup table for low-stock email alerts ─
  // The UNIQUE constraint on (workspace_owner_id, base_item_id, location_id)
  // enables an atomic INSERT…ON CONFLICT upsert that prevents duplicate alerts
  // under concurrent requests without a separate SELECT + INSERT race.
  await db.query(`
    CREATE TABLE IF NOT EXISTS low_stock_alert_notifications (
      id                 serial      PRIMARY KEY,
      workspace_owner_id text        NOT NULL,
      base_item_id       integer     NOT NULL,
      location_id        integer     NOT NULL,
      sent_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT low_stock_alert_notif_dedup UNIQUE (workspace_owner_id, base_item_id, location_id)
    );
  `);
  // Migration: add the unique constraint if the table was already created without it.
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'low_stock_alert_notif_dedup'
           AND conrelid = 'low_stock_alert_notifications'::regclass
      ) THEN
        ALTER TABLE low_stock_alert_notifications
          ADD CONSTRAINT low_stock_alert_notif_dedup
            UNIQUE (workspace_owner_id, base_item_id, location_id);
      END IF;
    END $$;
  `);
  logger.info("low_stock_alert_notifications table ready");

  // ── purchase_order_activity ───────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_order_activity (
      id                  serial      PRIMARY KEY,
      purchase_order_id   integer     NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      workspace_owner_id  text        NOT NULL,
      event_type          text        NOT NULL,
      description         text,
      metadata            jsonb,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_po_activity_po
      ON purchase_order_activity(purchase_order_id, created_at DESC);
  `);
  logger.info("purchase_order_activity table ready");

  // ── stock_alert_dismissals ─────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS stock_alert_dismissals (
      id                 serial      PRIMARY KEY,
      member_id          integer     NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      base_item_id       integer     NOT NULL REFERENCES base_items(id) ON DELETE CASCADE,
      location_id        integer     NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      dismissed_at       timestamptz NOT NULL DEFAULT now(),
      expires_at         timestamptz NOT NULL,
      stock_at_dismissal integer     NOT NULL DEFAULT 0,
      CONSTRAINT stock_alert_dismissals_unique UNIQUE (member_id, base_item_id, location_id)
    );
  `);
  await db.query(`ALTER TABLE stock_alert_dismissals ADD COLUMN IF NOT EXISTS stock_at_dismissal integer NOT NULL DEFAULT 0`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_stock_alert_dismissals_member
      ON stock_alert_dismissals(member_id, expires_at);
  `);
  logger.info("stock_alert_dismissals table ready");

  // ── purchase_order_line_items tax_override ─────────────────────────────────
  await db.query(`
    ALTER TABLE purchase_order_line_items
      ADD COLUMN IF NOT EXISTS tax_override boolean NOT NULL DEFAULT false;
  `);
  logger.info("purchase_order_line_items.tax_override ready");

  // ── Workshop Sales module ─────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS workshop_sales (
      id                          serial      PRIMARY KEY,
      workspace_owner_id          text        NOT NULL,
      order_number                text        NOT NULL,
      brand_id                    integer     REFERENCES brands(id) ON DELETE SET NULL,
      location_id                 integer     REFERENCES locations(id) ON DELETE SET NULL,
      country_id                  integer,
      sale_type                   text        NOT NULL DEFAULT 'custom',
      assigned_florist_member_id  integer     REFERENCES workspace_members(id) ON DELETE SET NULL,
      status                      text        NOT NULL DEFAULT 'draft',
      payment_status              text        NOT NULL DEFAULT 'unpaid',
      currency                    text        NOT NULL DEFAULT 'USD',
      customer_type               text        NOT NULL DEFAULT 'guest',
      customer_id                 integer     REFERENCES customers(id) ON DELETE SET NULL,
      customer_name               text,
      customer_phone              text,
      customer_email              text,
      request_description         text,
      occasion                    text,
      colors                      jsonb,
      style                       text,
      budget                      numeric,
      internal_notes              text,
      subtotal                    numeric     NOT NULL DEFAULT 0,
      discount_total              numeric     NOT NULL DEFAULT 0,
      tax_total                   numeric     NOT NULL DEFAULT 0,
      total                       numeric     NOT NULL DEFAULT 0,
      amount_paid                 numeric     NOT NULL DEFAULT 0,
      balance_due                 numeric     NOT NULL DEFAULT 0,
      cogs_amount                 numeric,
      cogs_percentage             numeric,
      cover_photo_id              integer,
      cancellation_reason         text,
      cancelled_at                timestamptz,
      cancelled_by                text,
      completed_at                timestamptz,
      created_by                  text,
      updated_by                  text,
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_workshop_sales_workspace
      ON workshop_sales(workspace_owner_id);
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workshop_sales_order_number_unique
      ON workshop_sales(workspace_owner_id, order_number);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS workshop_sale_items (
      id                  serial      PRIMARY KEY,
      workshop_sale_id    integer     NOT NULL REFERENCES workshop_sales(id) ON DELETE CASCADE,
      workspace_owner_id  text        NOT NULL,
      name                text        NOT NULL,
      description         text,
      quantity            numeric     NOT NULL DEFAULT 1,
      unit_price          numeric     NOT NULL DEFAULT 0,
      discount            numeric     NOT NULL DEFAULT 0,
      discount_type       text        NOT NULL DEFAULT 'amount',
      tax_rate            numeric     NOT NULL DEFAULT 0,
      total               numeric     NOT NULL DEFAULT 0,
      sort_order          integer     NOT NULL DEFAULT 0,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_workshop_sale_items_sale
      ON workshop_sale_items(workshop_sale_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS workshop_sale_payments (
      id                  serial      PRIMARY KEY,
      workshop_sale_id    integer     NOT NULL REFERENCES workshop_sales(id) ON DELETE CASCADE,
      workspace_owner_id  text        NOT NULL,
      method              text        NOT NULL DEFAULT 'cash',
      amount              numeric     NOT NULL DEFAULT 0,
      currency            text        NOT NULL DEFAULT 'USD',
      reference           text,
      collected_by        text,
      paid_at             timestamptz NOT NULL DEFAULT now(),
      notes               text,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_workshop_sale_payments_sale
      ON workshop_sale_payments(workshop_sale_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS workshop_sale_photos (
      id                  serial      PRIMARY KEY,
      workshop_sale_id    integer     NOT NULL REFERENCES workshop_sales(id) ON DELETE CASCADE,
      workspace_owner_id  text        NOT NULL,
      url                 text        NOT NULL,
      is_cover            boolean     NOT NULL DEFAULT false,
      caption             text,
      uploaded_by         text,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_workshop_sale_photos_sale
      ON workshop_sale_photos(workshop_sale_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS workshop_sale_activity_logs (
      id                  serial      PRIMARY KEY,
      workshop_sale_id    integer     NOT NULL REFERENCES workshop_sales(id) ON DELETE CASCADE,
      workspace_owner_id  text        NOT NULL,
      action              text        NOT NULL,
      description         text,
      actor_id            text,
      actor_name          text,
      metadata            jsonb,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_workshop_sale_activity_sale
      ON workshop_sale_activity_logs(workshop_sale_id, created_at);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS workshop_sale_inventory_usage (
      id                  serial      PRIMARY KEY,
      workshop_sale_id    integer     NOT NULL REFERENCES workshop_sales(id) ON DELETE CASCADE,
      workspace_owner_id  text        NOT NULL,
      base_item_id        integer     REFERENCES base_items(id) ON DELETE SET NULL,
      item_name           text,
      quantity            numeric     NOT NULL DEFAULT 0,
      unit                text,
      country_id          integer,
      notes               text,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_workshop_sale_inventory_sale
      ON workshop_sale_inventory_usage(workshop_sale_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS workshop_sale_counters (
      workspace_owner_id  text        NOT NULL,
      location_code       text        NOT NULL,
      year                integer     NOT NULL,
      seq                 integer     NOT NULL DEFAULT 0
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workshop_sale_counters_pk
      ON workshop_sale_counters(workspace_owner_id, location_code, year);
  `);
  logger.info("workshop_sales tables ready");
  // ── Workshop Cash Desk: cash_drawers ───────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_drawers (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      name                text        NOT NULL,
      code                text        NOT NULL,
      location_id         integer     REFERENCES locations(id) ON DELETE SET NULL,
      currency            text        NOT NULL DEFAULT 'AED',
      is_active           boolean     NOT NULL DEFAULT true,
      notes               text,
      created_by_clerk_id text,
      updated_by_clerk_id text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_drawers_workspace ON cash_drawers(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_drawers_location ON cash_drawers(location_id);`);
  // Optional second currency per drawer (nullable = single-currency drawer).
  await db.query(`ALTER TABLE cash_drawers ADD COLUMN IF NOT EXISTS secondary_currency text;`);
  logger.info("cash_drawers table ready");

  // ── Workshop Cash Desk: cash_sessions ──────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_sessions (
      id                  serial         PRIMARY KEY,
      workspace_owner_id  text           NOT NULL,
      session_number      text           NOT NULL,
      drawer_id           integer        NOT NULL REFERENCES cash_drawers(id) ON DELETE RESTRICT,
      location_id         integer        REFERENCES locations(id) ON DELETE SET NULL,
      currency            text           NOT NULL DEFAULT 'AED',
      status              text           NOT NULL DEFAULT 'open',
      opening_cash        numeric(14,2)  NOT NULL DEFAULT 0,
      cash_in_total       numeric(14,2)  NOT NULL DEFAULT 0,
      cash_out_total      numeric(14,2)  NOT NULL DEFAULT 0,
      adjustments_total   numeric(14,2)  NOT NULL DEFAULT 0,
      expected_cash       numeric(14,2),
      actual_cash         numeric(14,2),
      difference          numeric(14,2),
      opening_note        text,
      closing_note        text,
      flag_reason         text,
      reopen_reason       text,
      opened_by_member_id integer,
      opened_by_clerk_id  text,
      closed_by_clerk_id  text,
      approved_by_clerk_id text,
      opened_at           timestamptz    NOT NULL DEFAULT now(),
      closed_at           timestamptz,
      approved_at         timestamptz,
      created_at          timestamptz    NOT NULL DEFAULT now(),
      updated_at          timestamptz    NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_sessions_workspace ON cash_sessions(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_sessions_drawer ON cash_sessions(drawer_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON cash_sessions(workspace_owner_id, status);`);
  // ── Remediate pre-existing duplicate open sessions before enforcing uniqueness ──
  // IF this migration runs on an existing database that has multiple open sessions
  // for the same drawer (possible before this index existed), the CREATE UNIQUE INDEX
  // would fail even with IF NOT EXISTS.  Close all but the most recently opened
  // session per drawer first.  Idempotent: no-op when no duplicates exist.
  await db.query(`
    UPDATE cash_sessions
       SET status = 'pending_review', closed_at = COALESCE(closed_at, now())
     WHERE status = 'open'
       AND id NOT IN (
         SELECT DISTINCT ON (drawer_id) id
           FROM cash_sessions
          WHERE status = 'open'
          ORDER BY drawer_id, opened_at DESC NULLS LAST
       )
  `);
  // Enforce at most one open session per drawer — prevents race conditions in
  // CMC shift open where two concurrent requests could each insert a session.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_sessions_one_open_per_drawer ON cash_sessions(drawer_id) WHERE status = 'open';`);
  // Dual-currency sessions: when secondary_currency is set, the *_secondary
  // columns carry that currency's figures (nullable = single-currency session).
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS secondary_currency text;`);
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS opening_cash_secondary numeric(14,2);`);
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS cash_in_total_secondary numeric(14,2);`);
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS cash_out_total_secondary numeric(14,2);`);
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS adjustments_total_secondary numeric(14,2);`);
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS expected_cash_secondary numeric(14,2);`);
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS actual_cash_secondary numeric(14,2);`);
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS difference_secondary numeric(14,2);`);
  // Per-currency reconciliation counts captured at close time (Task: session detail redesign).
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS closing_counts jsonb;`);
  // Guided Reconcile & Close state (per-currency counts, approvals, snapshot).
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS reconciliation jsonb;`);
  logger.info("cash_sessions table ready");

  // ── Workshop Cash Desk: cash_transactions ──────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_transactions (
      id                  serial         PRIMARY KEY,
      workspace_owner_id  text           NOT NULL,
      cash_session_id     integer        REFERENCES cash_sessions(id) ON DELETE SET NULL,
      cash_drawer_id      integer        REFERENCES cash_drawers(id) ON DELETE SET NULL,
      location_id         integer        REFERENCES locations(id) ON DELETE SET NULL,
      currency            text           NOT NULL DEFAULT 'AED',
      type                text           NOT NULL DEFAULT 'sale',
      direction           text           NOT NULL DEFAULT 'in',
      amount              numeric(14,2)  NOT NULL,
      description         text,
      reference_type      text,
      reference_id        text,
      has_receipt         boolean        NOT NULL DEFAULT false,
      status              text           NOT NULL DEFAULT 'confirmed',
      created_by_clerk_id text,
      transaction_date    timestamptz    NOT NULL DEFAULT now(),
      created_at          timestamptz    NOT NULL DEFAULT now()
    );
  `);
  // Optional invoice/receipt attachment for bill-type transactions.
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS attachment_url text;`);
  // Session-detail redesign: sale/expense metadata + reversal-based corrections.
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS sale_channel text;`);
  // Backfill: tag existing CMC shelf-sale cash transactions with the walk_in channel.
  // These rows were created before sale_channel was populated on CMC sales.
  // Idempotent: only updates rows where reference_type = 'cmc_sale' and sale_channel IS NULL.
  {
    const backfill = await db.query(`
      UPDATE cash_transactions
         SET sale_channel = 'walk_in'
       WHERE type = 'cash_sale'
         AND reference_type = 'cmc_sale'
         AND sale_channel IS NULL
    `);
    if (backfill.rowCount && backfill.rowCount > 0) {
      logger.info(`cash_transactions walk_in backfill: tagged ${backfill.rowCount} CMC shelf-sale row(s)`);
    } else {
      logger.info("cash_transactions walk_in backfill: no rows needed updating");
    }
  }
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS expense_category text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS payee text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS reversal_of_id integer;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS reversal_reason text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS is_reversed boolean NOT NULL DEFAULT false;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transactions_workspace ON cash_transactions(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transactions_session ON cash_transactions(cash_session_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transactions_drawer ON cash_transactions(cash_drawer_id);`);
  // Multi-currency: document currency + residual balance classification.
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS transaction_currency text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS balance_difference_kind text;`);
  // Payroll expense columns — captured when expense_category = 'salaries_wages'.
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS payroll_employee_id text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS payroll_employee_name_snapshot text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS payroll_period text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS payroll_payment_type text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS payroll_notes text;`);
  // Salary expense approval lifecycle (confirmed | pending | declined | cancelled).
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'confirmed';`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS requested_by_clerk_id text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS approval_decided_by_clerk_id text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS approval_decided_at timestamptz;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS approval_decline_reason text;`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS approval_requester_ack_at timestamptz;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transactions_approval_pending ON cash_transactions(workspace_owner_id, approval_status) WHERE approval_status = 'pending';`);
  logger.info("cash_transactions table ready");

  // ── Workshop Cash Desk: cash_transaction_movements ─────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_transaction_movements (
      id                    serial         PRIMARY KEY,
      workspace_owner_id    text           NOT NULL,
      cash_transaction_id   integer        NOT NULL REFERENCES cash_transactions(id) ON DELETE CASCADE,
      direction             text           NOT NULL,
      kind                  text           NOT NULL,
      amount                numeric(14,2)  NOT NULL,
      currency              text           NOT NULL,
      exchange_rate         numeric(20,8),
      converted_amount      numeric(14,2),
      rate_source           text,
      override_approved_by  text,
      created_by_clerk_id   text,
      created_at            timestamptz    NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_txn_movements_transaction ON cash_transaction_movements(cash_transaction_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_txn_movements_workspace ON cash_transaction_movements(workspace_owner_id);`);
  // Idempotent column guards — ensure every column exists on databases created
  // before the full schema was in place in one shot.
  await db.query(`ALTER TABLE cash_transaction_movements ADD COLUMN IF NOT EXISTS exchange_rate numeric(20,8);`);
  await db.query(`ALTER TABLE cash_transaction_movements ADD COLUMN IF NOT EXISTS converted_amount numeric(14,2);`);
  await db.query(`ALTER TABLE cash_transaction_movements ADD COLUMN IF NOT EXISTS rate_source text;`);
  await db.query(`ALTER TABLE cash_transaction_movements ADD COLUMN IF NOT EXISTS override_approved_by text;`);
  await db.query(`ALTER TABLE cash_transaction_movements ADD COLUMN IF NOT EXISTS created_by_clerk_id text;`);
  logger.info("cash_transaction_movements table ready");

  // ── Workshop Cash Desk: cash_session_activity_logs ─────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_session_activity_logs (
      id                  serial         PRIMARY KEY,
      workspace_owner_id  text           NOT NULL,
      cash_session_id     integer        NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
      action              text           NOT NULL,
      actor_clerk_id      text,
      actor_name          text,
      detail              text,
      created_at          timestamptz    NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_session_activity_session ON cash_session_activity_logs(cash_session_id);`);
  logger.info("cash_session_activity_logs table ready");

  // ── Tookan integration columns on orders ───────────────────────────────────
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tookan_task_id   text;`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tookan_job_id    text;`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tookan_status    text;`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tookan_created_at timestamptz;`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tookan_error     text;`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tookan_payload   jsonb;`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tookan_delivered_at timestamptz;`);
  logger.info("tookan columns on orders ready");

  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS marketing_attribution jsonb;`);
  logger.info("orders.marketing_attribution column ready");

  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_date_review text;`);
  logger.info("orders.delivery_date_review column ready");

  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false;`);
  logger.info("orders.is_anonymous column ready");

  // Sensitive-occasion flag: auto-set at order creation when a line item is a
  // sympathy/funeral/condolence product; manually togglable from the order
  // page. Suppresses Trustpilot review invitations and any promotional sends.
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_sensitive_occasion boolean NOT NULL DEFAULT false;`);
  logger.info("orders.is_sensitive_occasion column ready");

  // ── Florist Orders workflow ────────────────────────────────────────────────
  // Florist location on workspace members: required (API-enforced) for members
  // whose role grants the `florist_orders` page.
  await db.query(`
    ALTER TABLE workspace_members
      ADD COLUMN IF NOT EXISTS florist_location_id integer REFERENCES locations(id) ON DELETE SET NULL;
  `);
  logger.info("workspace_members.florist_location_id column ready");

  // One florist assignment per order (UNIQUE order_id); re-sending replaces it.
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_florist_assignments (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      order_id            uuid        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      location_id         integer     NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      status              text        NOT NULL DEFAULT 'pending',
      assigned_by         text,
      started_at          timestamptz,
      completed_at        timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT order_florist_assignments_order_unique UNIQUE (order_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_florist_assignments_location
      ON order_florist_assignments(location_id, status);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_florist_assignments_workspace
      ON order_florist_assignments(workspace_owner_id);
  `);
  logger.info("order_florist_assignments table ready");

  // Photo verification workflow columns on florist assignments (durable
  // per-assignment state: card-print unlock, the two photo object paths, the
  // AI verification status/result audit record, and the Slack-sent marker).
  // All idempotent ADD COLUMN IF NOT EXISTS so safe to re-run.
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS card_printed_at timestamptz;`);
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS photo_items_path text;`);
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS photo_card_path text;`);
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'none';`);
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS verification_started_at timestamptz;`);
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS verification_result jsonb;`);
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS verified_at timestamptz;`);
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS slack_pending_at timestamptz;`);
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS slack_sent_at timestamptz;`);
  // photo_set_rev: monotonically increasing revision bumped on EVERY photo
  // attach/replace/remove; Slack sent-state writes are conditioned on it so a
  // send that raced a photo replacement can never mark the NEW set as sent.
  // slack_attempted_rev: revision of the last photo set for which an upload
  // may have reached Slack (persisted BEFORE the external call) — retries for
  // the same rev must reconcile against Slack history before re-uploading.
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS photo_set_rev integer NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS slack_attempted_rev integer;`);
  // card-on-box photo: only required when the order has a cake AND a card message.
  await db.query(`ALTER TABLE order_florist_assignments ADD COLUMN IF NOT EXISTS photo_card_on_box_path text;`);
  logger.info("order_florist_assignments photo verification columns ready");

  // A publication decision belongs to the exact florist photo revision, never
  // to the assignment generally.  Keeping the private source path here is
  // intentional: it is an internal audit value and is never selected by the
  // storefront route.
  await db.query(`
    CREATE TABLE IF NOT EXISTS florist_photo_publications (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      assignment_id integer NOT NULL REFERENCES order_florist_assignments(id) ON DELETE CASCADE,
      photo_set_rev integer NOT NULL,
      source_photo_path text NOT NULL,
      capture_at timestamptz NOT NULL DEFAULT now(),
      enabled boolean NOT NULL DEFAULT false,
      privacy_faces_clear boolean NOT NULL DEFAULT false,
      privacy_card_message_clear boolean NOT NULL DEFAULT false,
      privacy_address_clear boolean NOT NULL DEFAULT false,
      privacy_other_personal_info_clear boolean NOT NULL DEFAULT false,
      public_asset_key text,
      moderated_by text,
      moderated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT florist_photo_publications_revision_unique UNIQUE (assignment_id, photo_set_rev)
    );
    CREATE INDEX IF NOT EXISTS idx_florist_photo_publications_feed
      ON florist_photo_publications(workspace_owner_id, enabled, assignment_id, photo_set_rev)
      WHERE enabled = true;

      -- A new upload/removal, assignment replacement, or failed verification
      -- invalidates a previous
    -- moderation decision immediately, even if an old public copy remains in
    -- object storage.  The feed also compares revisions as defence in depth.
    CREATE OR REPLACE FUNCTION invalidate_florist_photo_publication()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.photo_set_rev <> OLD.photo_set_rev
         OR NEW.photo_items_path IS DISTINCT FROM OLD.photo_items_path
         OR NEW.verification_status <> 'approved' THEN
         UPDATE florist_photo_publications
            SET enabled = false, publication_status = 'stale',
                lease_token = NULL, lease_until = NULL, updated_at = now()
          WHERE assignment_id = NEW.id AND publication_status <> 'stale';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_invalidate_florist_photo_publication
      ON order_florist_assignments;
    CREATE TRIGGER trg_invalidate_florist_photo_publication
      AFTER UPDATE OF photo_set_rev, photo_items_path, verification_status ON order_florist_assignments
      FOR EACH ROW EXECUTE FUNCTION invalidate_florist_photo_publication();
  `);
  logger.info("florist_photo_publications table ready");
  // Automatic publishing worker state. Existing manually-created records are
  // fail-closed until the automatic pipeline explicitly processes a revision.
  await db.query(`
    ALTER TABLE florist_photo_publications
      ADD COLUMN IF NOT EXISTS publication_status text NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
      ADD COLUMN IF NOT EXISTS lease_token text,
      ADD COLUMN IF NOT EXISTS lease_until timestamptz,
       ADD COLUMN IF NOT EXISTS last_error text,
       ADD COLUMN IF NOT EXISTS automatic boolean NOT NULL DEFAULT false,
       ADD COLUMN IF NOT EXISTS public_asset_base_key text;
    -- Prior versions used this table for manual moderation. Never let those
    -- rows enter the automatic feed merely because they have a public key.
    -- Rows created by the former automatic pipeline must not remain live after
    -- the moderation contract is restored. Explicit admin rows use
    -- automatic=false and are left alone.
    UPDATE florist_photo_publications SET publication_status='stale', enabled=false
      WHERE automatic=true AND publication_status <> 'stale';
    ALTER TABLE florist_photo_publications DROP CONSTRAINT IF EXISTS florist_photo_publications_status_check;
    ALTER TABLE florist_photo_publications ADD CONSTRAINT florist_photo_publications_status_check
      CHECK (publication_status IN ('pending','processing','ready','failed','stale'));

    CREATE OR REPLACE FUNCTION invalidate_florist_photo_publication()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.photo_set_rev <> OLD.photo_set_rev
         OR NEW.photo_items_path IS DISTINCT FROM OLD.photo_items_path
         OR NEW.verification_status <> 'approved' THEN
        UPDATE florist_photo_publications
           SET enabled=false, publication_status='stale', lease_token=NULL,
               lease_until=NULL, updated_at=now()
         WHERE assignment_id=NEW.id AND publication_status <> 'stale';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- Database lifecycle hooks cover every writer (including integrations that
    -- do not go through Express). They only enqueue; storage I/O remains in the
    -- bounded worker after the transaction commits.
    CREATE OR REPLACE FUNCTION enqueue_current_real_delivery_photo()
    RETURNS trigger AS $$
    BEGIN
      INSERT INTO florist_photo_publications
         (workspace_owner_id, assignment_id, photo_set_rev, source_photo_path, publication_status,
          enabled, next_attempt_at, automatic)
      SELECT a.workspace_owner_id, a.id, a.photo_set_rev, a.photo_items_path, 'pending',
              false, NULL, false
        FROM order_florist_assignments a
        JOIN orders o ON o.id=a.order_id AND o.workspace_owner_id=a.workspace_owner_id
       WHERE a.id=NEW.id AND a.verification_status='approved'
         AND a.photo_items_path IS NOT NULL AND o.status='completed'
       ON CONFLICT (assignment_id, photo_set_rev) DO NOTHING;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_enqueue_real_delivery_on_verification ON order_florist_assignments;
    CREATE TRIGGER trg_enqueue_real_delivery_on_verification
      AFTER UPDATE OF verification_status ON order_florist_assignments
      FOR EACH ROW WHEN (NEW.verification_status='approved')
      EXECUTE FUNCTION enqueue_current_real_delivery_photo();

    CREATE OR REPLACE FUNCTION enqueue_real_delivery_on_order_completion()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.status='completed' THEN
        INSERT INTO florist_photo_publications
           (workspace_owner_id, assignment_id, photo_set_rev, source_photo_path, publication_status,
            enabled, next_attempt_at, automatic)
        SELECT a.workspace_owner_id, a.id, a.photo_set_rev, a.photo_items_path, 'pending',
               false, NULL, false
          FROM order_florist_assignments a
         WHERE a.order_id=NEW.id AND a.workspace_owner_id=NEW.workspace_owner_id
           AND a.verification_status='approved' AND a.photo_items_path IS NOT NULL
         ON CONFLICT (assignment_id, photo_set_rev) DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_enqueue_real_delivery_on_order_completion ON orders;
    CREATE TRIGGER trg_enqueue_real_delivery_on_order_completion
      AFTER UPDATE OF status ON orders
      FOR EACH ROW WHEN (NEW.status='completed')
      EXECUTE FUNCTION enqueue_real_delivery_on_order_completion();
  `);
  await reconcileCompletedFloristAssignments(db);
  logger.info("completed florist assignments reconciled");

  // Branch print configs — branch/shop name → Make.com machineId/printerId
  // pairs for the card-message print flow (replaces CARD_PRINT_BRANCH_CONFIG).
  await db.query(`
    CREATE TABLE IF NOT EXISTS branch_print_configs (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      name                text        NOT NULL,
      machine_id          text        NOT NULL,
      printer_id          text        NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_print_configs_workspace_name
      ON branch_print_configs(workspace_owner_id, name);
  `);
  logger.info("branch_print_configs table ready");

  // Card print logs — one row per successful card print sent from the Order
  // Detail print dialog. Records who printed, from which branch, for which order.
  await db.query(`
    CREATE TABLE IF NOT EXISTS card_print_logs (
      id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text        NOT NULL,
      order_id            text        NOT NULL,
      real_order_id       uuid,
      user_id             text        NOT NULL,
      user_display_name   text        NOT NULL,
      location            text        NOT NULL,
      shop_name           text        NOT NULL,
      printed_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_card_print_logs_real_order
      ON card_print_logs(real_order_id, workspace_owner_id)
      WHERE real_order_id IS NOT NULL;
  `);
  logger.info("card_print_logs table ready");

  // ── Weekly Sales Digest (task #2830) ────────────────────────────────────────
  // Per-workspace digest settings (owner-managed) + an idempotency ledger of
  // sends (one row per workspace per ISO week, keyed by the Monday date).
  await db.query(`
    CREATE TABLE IF NOT EXISTS weekly_digest_settings (
      workspace_owner_id  text        PRIMARY KEY,
      enabled             boolean     NOT NULL DEFAULT false,
      extra_recipients    jsonb       NOT NULL DEFAULT '[]'::jsonb,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS weekly_digest_sends (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      week_start          date        NOT NULL,
      sent_at             timestamptz NOT NULL DEFAULT now(),
      recipients          jsonb
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_digest_sends_owner_week
      ON weekly_digest_sends(workspace_owner_id, week_start);
  `);
  logger.info("weekly_digest tables ready");

  // ── Website analytics ingestion (task #2904) ────────────────────────────────
  // web_events: behavioral events pushed from presentail.com via workspace
  // API key. Append-only, suitable for funnel/session/search aggregation.
  await db.query(`
    CREATE TABLE IF NOT EXISTS web_events (
      id                 bigserial   PRIMARY KEY,
      workspace_owner_id text        NOT NULL,
      event_type         text        NOT NULL,
      session_id         text,
      visitor_id         text,
      occurred_at        timestamptz NOT NULL,
      received_at        timestamptz NOT NULL DEFAULT now(),
      url                text,
      path               text,
      referrer           text,
      traffic_source     text,
      utm_source         text,
      utm_medium         text,
      utm_campaign       text,
      utm_term           text,
      utm_content        text,
      device_type        text,
      language           text,
      country            text,
      city               text,
      product_ref        text,
      category           text,
      occasion           text,
      brand              text,
      search_query       text,
      result_count       integer,
      value              numeric(12,2),
      currency           text,
      properties         jsonb       NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_web_events_owner_time ON web_events(workspace_owner_id, occurred_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_web_events_owner_type_time ON web_events(workspace_owner_id, event_type, occurred_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_web_events_owner_session ON web_events(workspace_owner_id, session_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_web_events_retention ON web_events(received_at);`);
  logger.info("web_events table ready");

  // ad_spend_entries: marketing ad spend per channel/campaign and period
  // (for ROAS/CAC). Owner-managed (manual entry or bulk import).
  await db.query(`
    CREATE TABLE IF NOT EXISTS ad_spend_entries (
      id                   serial      PRIMARY KEY,
      workspace_owner_id   text        NOT NULL,
      channel              text        NOT NULL,
      campaign             text,
      campaign_external_id text,
      period_start         date        NOT NULL,
      period_end           date        NOT NULL,
      spend_amount         numeric(12,2) NOT NULL,
      currency             text        NOT NULL DEFAULT 'AED',
      impressions          integer,
      clicks               integer,
      conversions          integer,
      source               text        NOT NULL DEFAULT 'manual',
      notes                text,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ad_spend_owner_period ON ad_spend_entries(workspace_owner_id, period_start, period_end);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ad_spend_owner_channel ON ad_spend_entries(workspace_owner_id, channel);`);
  // Unique key for idempotent upsert per channel/campaign/period. Plain composite
  // index with NULLS NOT DISTINCT (PG15+) so NULL campaigns collapse to a single
  // slot rather than bypassing uniqueness. A COALESCE expression index mixed with
  // the date columns made Replit's publish diff emit an invalid `date_ops` operator
  // class on the text columns; a plain composite index introspects/re-emits cleanly.
  // Guarded drop migrates any legacy COALESCE / NULLS-DISTINCT index to this shape.
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'idx_ad_spend_unique'
          AND (i.indnullsnotdistinct = false OR pg_get_indexdef(i.indexrelid) LIKE '%COALESCE%')
      ) THEN
        DROP INDEX idx_ad_spend_unique;
      END IF;
    END$$;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_spend_unique
      ON ad_spend_entries(workspace_owner_id, channel, campaign, period_start, period_end)
      NULLS NOT DISTINCT;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ad_spend_api_external_lookup
      ON ad_spend_entries(
        workspace_owner_id, channel, source, campaign_external_id, period_start, period_end
      )
      WHERE campaign_external_id IS NOT NULL AND source IN ('google_ads_api', 'meta_api');
  `);
  logger.info("ad_spend_entries table ready");

  // ad_platform_connections: per-workspace ad platform (Google Ads / Meta Ads)
  // connection + sync state. Credentials are stored AES-256-GCM encrypted.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ad_platform_connections (
      id                    serial      PRIMARY KEY,
      workspace_owner_id    text        NOT NULL,
      platform              text        NOT NULL,
      credentials_encrypted text        NOT NULL,
      auth_mode             text,
      account_label         text,
      account_currency      text,
      account_time_zone     text,
      account_created_time  text,
      sync_status           text        NOT NULL DEFAULT 'idle',
      last_sync_at          timestamptz,
      last_full_sync_at     timestamptz,
      last_error            text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Safe additive migration for installations created before account timezone
  // metadata existed. Never rewrite credentials_encrypted (legacy blobs are
  // retained for Meta and historical Google connections).
  await db.query(`
    ALTER TABLE ad_platform_connections
      ADD COLUMN IF NOT EXISTS account_time_zone text;
  `);
  await db.query(`
    ALTER TABLE ad_platform_connections
      ADD COLUMN IF NOT EXISTS auth_mode text;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_platform_connections_unique
      ON ad_platform_connections(workspace_owner_id, platform);
  `);
  logger.info("ad_platform_connections table ready");

  // seo_metrics: SEO performance per landing page/query and period. Owner-
  // managed (manual entry or import from Google Search Console).
  await db.query(`
    CREATE TABLE IF NOT EXISTS seo_metrics (
      id                 serial      PRIMARY KEY,
      workspace_owner_id text        NOT NULL,
      period_start       date        NOT NULL,
      period_end         date        NOT NULL,
      landing_page       text,
      query              text,
      impressions        integer     NOT NULL DEFAULT 0,
      clicks             integer     NOT NULL DEFAULT 0,
      ctr                numeric(6,4),
      avg_position       numeric(6,2),
      source             text        NOT NULL DEFAULT 'manual',
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_seo_metrics_owner_period ON seo_metrics(workspace_owner_id, period_start, period_end);`);
  // See idx_ad_spend_unique note: plain composite + NULLS NOT DISTINCT instead of a
  // COALESCE expression index so the publish diff re-emits valid SQL. Guarded drop
  // migrates any legacy COALESCE / NULLS-DISTINCT index to this shape.
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'idx_seo_metrics_unique'
          AND (i.indnullsnotdistinct = false OR pg_get_indexdef(i.indexrelid) LIKE '%COALESCE%')
      ) THEN
        DROP INDEX idx_seo_metrics_unique;
      END IF;
    END$$;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_metrics_unique
      ON seo_metrics(workspace_owner_id, period_start, period_end, landing_page, query)
      NULLS NOT DISTINCT;
  `);
  logger.info("seo_metrics table ready");

  // search_console_connections: per-workspace Google Search Console OAuth
  // connection + sync state. One row per workspace (unique on workspace_owner_id).
  await db.query(`
    CREATE TABLE IF NOT EXISTS search_console_connections (
      id                   serial      PRIMARY KEY,
      workspace_owner_id   text        NOT NULL,
      site_url             text        NOT NULL,
      credentials_encrypted text       NOT NULL,
      sync_status          text        NOT NULL DEFAULT 'idle',
      last_sync_at         timestamptz,
      last_error           text,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_search_console_connections_unique
      ON search_console_connections(workspace_owner_id);
  `);
  logger.info("search_console_connections table ready");

  // search_console_oauth_config: stores workspace-supplied OAuth Client ID+Secret
  // before (or instead of) completing an OAuth flow. One row per workspace.
  // This remains an additive migration for restored databases that have only
  // the older search_console_connections table. Existing connection rows and
  // encrypted tokens are never rewritten or deleted during initialization.
  await db.query(`
    CREATE TABLE IF NOT EXISTS search_console_oauth_config (
      id                    serial      PRIMARY KEY,
      workspace_owner_id    text        NOT NULL,
      oauth_client_encrypted text       NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_search_console_oauth_config_unique
      ON search_console_oauth_config(workspace_owner_id);
  `);
  logger.info("search_console_oauth_config table ready");

  // Short-lived, single-use state tokens bind Google Search Console OAuth
  // callbacks to the owner who initiated the authorization.
  await db.query(`
    CREATE TABLE IF NOT EXISTS search_console_oauth_states (
      state              text PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      expires_at         timestamptz NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_search_console_oauth_states_expires_at
      ON search_console_oauth_states(expires_at);
  `);
  logger.info("search_console_oauth_states table ready");

  // ── web_push_subscriptions — browser Web Push (VAPID) subscriptions ────────
  // One row per browser endpoint; workspace-scoped so new-order alerts fan out
  // to every subscribed dashboard member of the workspace.
  await db.query(`
    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      user_id             text NOT NULL,
      endpoint            text NOT NULL,
      p256dh              text NOT NULL,
      auth                text NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_web_push_subscriptions_endpoint
      ON web_push_subscriptions(endpoint);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_workspace
      ON web_push_subscriptions(workspace_owner_id);
  `);
  logger.info("web_push_subscriptions table ready");

  // ── Finance & Accounting: monthly close tables ────────────────────────────

  // accounting_months — top-level monthly close record per workspace
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_months (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      year                integer     NOT NULL,
      month               integer     NOT NULL CHECK (month BETWEEN 1 AND 12),
      status              text        NOT NULL DEFAULT 'draft',
      notes               text,
      locked_at           timestamptz,
      locked_by           text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounting_months_workspace_year_month_unique
      ON accounting_months(workspace_owner_id, year, month);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_accounting_months_workspace
      ON accounting_months(workspace_owner_id, year, month);
  `);
  logger.info("accounting_months table ready");

  // accounting_entity_months — per-entity status within a monthly close
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_entity_months (
      id                    serial      PRIMARY KEY,
      accounting_month_id   integer     NOT NULL REFERENCES accounting_months(id) ON DELETE CASCADE,
      workspace_owner_id    text        NOT NULL,
      entity_id             integer     NOT NULL,
      status                text        NOT NULL DEFAULT 'draft',
      notes                 text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounting_entity_months_month_entity_unique
      ON accounting_entity_months(accounting_month_id, entity_id);
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_accounting_entity_months_month ON accounting_entity_months(accounting_month_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_accounting_entity_months_workspace ON accounting_entity_months(workspace_owner_id);`);
  logger.info("accounting_entity_months table ready");

  // accounting_sources — source definitions per workspace/entity
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_sources (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      entity_id           integer     NOT NULL,
      name                text        NOT NULL,
      source_type         text        NOT NULL,
      is_active           boolean     NOT NULL DEFAULT true,
      is_intercompany     boolean     NOT NULL DEFAULT false,
      sort_order          integer     NOT NULL DEFAULT 0,
      config              jsonb       NOT NULL DEFAULT '{}',
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounting_sources_workspace_entity_name_unique
      ON accounting_sources(workspace_owner_id, entity_id, name);
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_accounting_sources_workspace_entity ON accounting_sources(workspace_owner_id, entity_id);`);
  await db.query(`ALTER TABLE accounting_sources ADD COLUMN IF NOT EXISTS is_auto_sync boolean NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE accounting_sources ADD COLUMN IF NOT EXISTS is_intercompany boolean NOT NULL DEFAULT false;`);
  logger.info("accounting_sources table ready");

  // accounting_source_months — per-source reconciliation data per month
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_source_months (
      id                          serial      PRIMARY KEY,
      accounting_entity_month_id  integer     NOT NULL REFERENCES accounting_entity_months(id) ON DELETE CASCADE,
      source_id                   integer     NOT NULL REFERENCES accounting_sources(id) ON DELETE CASCADE,
      status                      text        NOT NULL DEFAULT 'pending',
      total_amount_cents          integer,
      variance_cents              integer,
      notes                       text,
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounting_source_months_entity_month_source_unique
      ON accounting_source_months(accounting_entity_month_id, source_id);
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_accounting_source_months_entity_month ON accounting_source_months(accounting_entity_month_id);`);
  // Extended columns for import tracking
  await db.query(`ALTER TABLE accounting_source_months ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;`);
  await db.query(`ALTER TABLE accounting_source_months ADD COLUMN IF NOT EXISTS rows_count integer NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE accounting_source_months ADD COLUMN IF NOT EXISTS sales_status text NOT NULL DEFAULT 'pending';`);
  logger.info("accounting_source_months table ready");

  // Extend accounting_source_months with per-source financial columns
  await db.query(`
    ALTER TABLE accounting_source_months
      ADD COLUMN IF NOT EXISTS os_sales_cents          integer,
      ADD COLUMN IF NOT EXISTS external_source_cents   integer,
      ADD COLUMN IF NOT EXISTS refunds_cents           integer,
      ADD COLUMN IF NOT EXISTS fees_cents              integer,
      ADD COLUMN IF NOT EXISTS net_activity_cents      integer,
      ADD COLUMN IF NOT EXISTS payout_status           text,
      ADD COLUMN IF NOT EXISTS last_synced_at          timestamptz;
  `);
  // Sync tracking columns added to accounting_source_months (idempotent)
  await db.query(`ALTER TABLE accounting_source_months ADD COLUMN IF NOT EXISTS sales_amount_cents bigint`);
  await db.query(`ALTER TABLE accounting_source_months ADD COLUMN IF NOT EXISTS refunds_amount_cents bigint`);
  await db.query(`ALTER TABLE accounting_source_months ADD COLUMN IF NOT EXISTS sync_type text DEFAULT 'manual'`);

  // source_sync_runs — history of automated sync attempts per source-month
  await db.query(`
    CREATE TABLE IF NOT EXISTS source_sync_runs (
      id                serial      PRIMARY KEY,
      source_month_id   integer     NOT NULL REFERENCES accounting_source_months(id) ON DELETE CASCADE,
      status            text        NOT NULL DEFAULT 'running',
      started_at        timestamptz NOT NULL DEFAULT now(),
      completed_at      timestamptz,
      error_message     text,
      records_synced    integer     NOT NULL DEFAULT 0,
      created_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_source_sync_runs_source_month ON source_sync_runs(source_month_id, started_at);`);
  // Extended columns for manual CSV/Excel import runs (template_id FK added after import_templates is created below)
  await db.query(`ALTER TABLE source_sync_runs ADD COLUMN IF NOT EXISTS filename text;`);
  await db.query(`ALTER TABLE source_sync_runs ADD COLUMN IF NOT EXISTS uploaded_by text;`);
  await db.query(`ALTER TABLE source_sync_runs ADD COLUMN IF NOT EXISTS rows_accepted integer NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE source_sync_runs ADD COLUMN IF NOT EXISTS rows_rejected integer NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE source_sync_runs ADD COLUMN IF NOT EXISTS total_gross_cents bigint;`);
  await db.query(`ALTER TABLE source_sync_runs ADD COLUMN IF NOT EXISTS total_refunds_cents bigint;`);
  await db.query(`ALTER TABLE source_sync_runs ADD COLUMN IF NOT EXISTS total_fees_cents bigint;`);
  await db.query(`ALTER TABLE source_sync_runs ADD COLUMN IF NOT EXISTS storage_path text;`);
  logger.info("source_sync_runs table ready");

  // source_statement_lines — individual imported/synced statement lines
  await db.query(`
    CREATE TABLE IF NOT EXISTS source_statement_lines (
      id                serial      PRIMARY KEY,
      source_month_id   integer     NOT NULL REFERENCES accounting_source_months(id) ON DELETE CASCADE,
      line_date         text,
      description       text,
      amount_cents      integer     NOT NULL,
      currency          text        NOT NULL DEFAULT 'USD',
      reference         text,
      is_matched        boolean     NOT NULL DEFAULT false,
      metadata          jsonb       NOT NULL DEFAULT '{}',
      created_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_source_statement_lines_source_month ON source_statement_lines(source_month_id);`);
  // Columns for dedup and rollback support
  await db.query(`ALTER TABLE source_statement_lines ADD COLUMN IF NOT EXISTS external_ref text;`);
  await db.query(`ALTER TABLE source_statement_lines ADD COLUMN IF NOT EXISTS sync_run_id integer REFERENCES source_sync_runs(id) ON DELETE CASCADE;`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_source_statement_lines_dedup
      ON source_statement_lines(source_month_id, external_ref)
      WHERE external_ref IS NOT NULL;
  `);
  logger.info("source_statement_lines table ready");

  // accounting_exceptions — flagged discrepancies per month
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_exceptions (
      id                    serial      PRIMARY KEY,
      accounting_month_id   integer     NOT NULL REFERENCES accounting_months(id) ON DELETE CASCADE,
      entity_id             integer,
      exception_type        text        NOT NULL,
      description           text        NOT NULL,
      amount_cents          integer,
      status                text        NOT NULL DEFAULT 'open',
      resolved_by           text,
      resolved_at           timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_accounting_exceptions_month ON accounting_exceptions(accounting_month_id);`);
  logger.info("accounting_exceptions table ready");

  // Source reference on accounting_exceptions (idempotent)
  await db.query(`ALTER TABLE accounting_exceptions ADD COLUMN IF NOT EXISTS source_month_id integer`);

  // Reconciliation & exception management columns
  await db.query(`ALTER TABLE accounting_exceptions ADD COLUMN IF NOT EXISTS assigned_to text`);
  await db.query(`ALTER TABLE accounting_exceptions ADD COLUMN IF NOT EXISTS notes text`);
  await db.query(`ALTER TABLE accounting_exceptions ADD COLUMN IF NOT EXISTS resolution text`);
  await db.query(`ALTER TABLE accounting_exceptions ADD COLUMN IF NOT EXISTS accepted_difference_reason text`);
  await db.query(`ALTER TABLE accounting_exceptions ADD COLUMN IF NOT EXISTS currency text`);
  await db.query(`ALTER TABLE accounting_exceptions ADD COLUMN IF NOT EXISTS external_ref text`);
  await db.query(`ALTER TABLE accounting_exceptions ADD COLUMN IF NOT EXISTS related_order_id text`);
  await db.query(`ALTER TABLE accounting_exceptions ADD COLUMN IF NOT EXISTS audit_trail jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_accounting_exceptions_status ON accounting_exceptions(accounting_month_id, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_accounting_exceptions_assignee ON accounting_exceptions(assigned_to) WHERE assigned_to IS NOT NULL`);
  logger.info("accounting_exceptions reconciliation columns ready");

  // close_checklist_items — ordered close checklist per month
  await db.query(`
    CREATE TABLE IF NOT EXISTS close_checklist_items (
      id                    serial      PRIMARY KEY,
      accounting_month_id   integer     NOT NULL REFERENCES accounting_months(id) ON DELETE CASCADE,
      label                 text        NOT NULL,
      is_checked            boolean     NOT NULL DEFAULT false,
      checked_by            text,
      checked_at            timestamptz,
      sort_order            integer     NOT NULL DEFAULT 0,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_close_checklist_items_month ON close_checklist_items(accounting_month_id, sort_order);`);
  await db.query(`
    ALTER TABLE close_checklist_items
      ADD COLUMN IF NOT EXISTS entity_id integer;
  `);
  logger.info("close_checklist_items table ready");

  // accounting_documents — uploaded supporting documents per month
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_documents (
      id                    serial      PRIMARY KEY,
      accounting_month_id   integer     NOT NULL REFERENCES accounting_months(id) ON DELETE CASCADE,
      name                  text        NOT NULL,
      storage_path          text        NOT NULL,
      mime_type             text,
      uploaded_by           text        NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_accounting_documents_month ON accounting_documents(accounting_month_id);`);
  logger.info("accounting_documents table ready");

  // journal_entry_drafts — journal entry headers per month
  await db.query(`
    CREATE TABLE IF NOT EXISTS journal_entry_drafts (
      id                    serial      PRIMARY KEY,
      workspace_owner_id    text        NOT NULL,
      accounting_month_id   integer     REFERENCES accounting_months(id) ON DELETE SET NULL,
      description           text        NOT NULL,
      status                text        NOT NULL DEFAULT 'draft',
      created_by            text        NOT NULL,
      posted_at             timestamptz,
      posted_by             text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_journal_entry_drafts_workspace ON journal_entry_drafts(workspace_owner_id, created_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_journal_entry_drafts_month ON journal_entry_drafts(accounting_month_id);`);
  logger.info("journal_entry_drafts table ready");

  // journal_entry_lines — individual debit/credit lines per journal entry
  await db.query(`
    CREATE TABLE IF NOT EXISTS journal_entry_lines (
      id                serial      PRIMARY KEY,
      journal_entry_id  integer     NOT NULL REFERENCES journal_entry_drafts(id) ON DELETE CASCADE,
      account_code      text        NOT NULL,
      account_name      text        NOT NULL,
      debit_cents       integer     NOT NULL DEFAULT 0,
      credit_cents      integer     NOT NULL DEFAULT 0,
      description       text,
      created_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_entry ON journal_entry_lines(journal_entry_id);`);
  logger.info("journal_entry_lines table ready");

  // import_templates — saved column-mapping templates for CSV/Excel imports
  await db.query(`
    CREATE TABLE IF NOT EXISTS import_templates (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      name                text        NOT NULL,
      source_type         text        NOT NULL,
      column_mappings     jsonb       NOT NULL DEFAULT '{}',
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_import_templates_workspace ON import_templates(workspace_owner_id);`);
  logger.info("import_templates table ready");
  // FK from source_sync_runs to import_templates (deferred here because import_templates didn't exist above)
  await db.query(`ALTER TABLE source_sync_runs ADD COLUMN IF NOT EXISTS template_id integer REFERENCES import_templates(id) ON DELETE SET NULL;`);

  // close_audit_events — immutable audit trail for the monthly close process
  await db.query(`
    CREATE TABLE IF NOT EXISTS close_audit_events (
      id                    serial      PRIMARY KEY,
      accounting_month_id   integer     NOT NULL REFERENCES accounting_months(id) ON DELETE CASCADE,
      event_type            text        NOT NULL,
      actor_user_id         text,
      description           text        NOT NULL,
      metadata              jsonb       NOT NULL DEFAULT '{}',
      created_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_close_audit_events_month ON close_audit_events(accounting_month_id, created_at);`);
  logger.info("close_audit_events table ready");

  // Close-workflow extension columns on accounting_entity_months
  await db.query(`ALTER TABLE accounting_entity_months ADD COLUMN IF NOT EXISTS snapshot jsonb`);
  await db.query(`ALTER TABLE accounting_entity_months ADD COLUMN IF NOT EXISTS closed_at timestamptz`);
  await db.query(`ALTER TABLE accounting_entity_months ADD COLUMN IF NOT EXISTS closed_by text`);
  await db.query(`ALTER TABLE accounting_entity_months ADD COLUMN IF NOT EXISTS reopened_at timestamptz`);
  await db.query(`ALTER TABLE accounting_entity_months ADD COLUMN IF NOT EXISTS reopened_by text`);
  await db.query(`ALTER TABLE accounting_entity_months ADD COLUMN IF NOT EXISTS reviewer_id text`);
  await db.query(`ALTER TABLE accounting_entity_months ADD COLUMN IF NOT EXISTS prepared_by text`);
  logger.info("accounting_entity_months close columns ready");

  // Post-close adjustment flag on exceptions
  await db.query(`ALTER TABLE accounting_exceptions ADD COLUMN IF NOT EXISTS is_post_close boolean NOT NULL DEFAULT false`);
  logger.info("accounting_exceptions is_post_close column ready");

  // Extended FK + type columns on accounting_documents
  await db.query(`ALTER TABLE accounting_documents ADD COLUMN IF NOT EXISTS entity_month_id integer REFERENCES accounting_entity_months(id) ON DELETE CASCADE`);
  await db.query(`ALTER TABLE accounting_documents ADD COLUMN IF NOT EXISTS document_type text`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_accounting_documents_entity_month ON accounting_documents(entity_month_id) WHERE entity_month_id IS NOT NULL`);
  logger.info("accounting_documents extended columns ready");

  // vat_summaries — VAT breakdown per entity-month
  await db.query(`
    CREATE TABLE IF NOT EXISTS vat_summaries (
      id                          serial      PRIMARY KEY,
      accounting_entity_month_id  integer     NOT NULL REFERENCES accounting_entity_months(id) ON DELETE CASCADE,
      vat_rate                    integer     NOT NULL,
      taxable_amount_cents        integer     NOT NULL DEFAULT 0,
      vat_amount_cents            integer     NOT NULL DEFAULT 0,
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_vat_summaries_entity_month ON vat_summaries(accounting_entity_month_id);`);
  logger.info("vat_summaries table ready");

  // channel_accounting_configs — maps a channel to an accounting source
  await db.query(`
    CREATE TABLE IF NOT EXISTS channel_accounting_configs (
      id                    serial      PRIMARY KEY,
      workspace_owner_id    text        NOT NULL,
      channel_id            integer     NOT NULL,
      accounting_source_id  integer     REFERENCES accounting_sources(id) ON DELETE SET NULL,
      is_active             boolean     NOT NULL DEFAULT true,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS channel_accounting_configs_workspace_channel_unique
      ON channel_accounting_configs(workspace_owner_id, channel_id);
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_channel_accounting_configs_workspace ON channel_accounting_configs(workspace_owner_id);`);
  logger.info("channel_accounting_configs table ready");

  // Entity-specific accounting_sources seed (idempotent).
  // Lebanon entities get retail + marketplace + bank-transfer sources, plus one
  // intercompany row. Cyprus/LTD entities get online settlement sources.
  // All other entities fall back to a generic set.
  // ON CONFLICT DO NOTHING preserves any existing reconciled records.
  await db.query(`
    DO $$
    DECLARE
      entity_rec record;
    BEGIN
      FOR entity_rec IN
        SELECT id, workspace_owner_id, legal_name, country FROM finance_entities
      LOOP
        IF entity_rec.country = 'LB' OR entity_rec.legal_name ILIKE '%SAL%' OR entity_rec.legal_name ILIKE '%Lebanon%' THEN
          -- Lebanon (Presentail SAL): retail + marketplace + bank transfers.
          -- source_type values match the canonical handler dispatch:
          -- retail_cash → syncRetailCash, card_terminal → syncRetailCard,
          -- marketplace/bank sources use 'manual' (no auto-sync handler).
          INSERT INTO accounting_sources (workspace_owner_id, entity_id, name, source_type, sort_order, is_intercompany)
          VALUES
            (entity_rec.workspace_owner_id, entity_rec.id, 'Retail — Cash',             'retail_cash',     1, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Retail — Card Terminal',     'card_terminal',   2, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Toters',                     'manual',          3, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Wish',                       'manual',          4, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Customer Bank Transfers',    'bank_transfer',   5, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Intercompany transfers from Presentail LTD', 'manual', 10, true)
          ON CONFLICT (workspace_owner_id, entity_id, name) DO NOTHING;

        ELSIF entity_rec.country = 'CY' OR entity_rec.legal_name ILIKE '%LTD%' OR entity_rec.legal_name ILIKE '%Cyprus%' THEN
          -- Cyprus (Presentail LTD): online settlement sources.
          -- source_type values match canonical handlers: stripe → runStripeSync,
          -- paypal → runPaypalSync, marketplace sources use 'manual'.
          INSERT INTO accounting_sources (workspace_owner_id, entity_id, name, source_type, sort_order, is_intercompany)
          VALUES
            (entity_rec.workspace_owner_id, entity_rec.id, 'Website — Stripe',  'stripe',  1, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Website — PayPal',  'paypal',  2, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Wolt',              'manual',  3, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Bolt',              'manual',  4, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Foodie',            'manual',  5, false)
          ON CONFLICT (workspace_owner_id, entity_id, name) DO NOTHING;

        ELSE
          -- Generic fallback
          INSERT INTO accounting_sources (workspace_owner_id, entity_id, name, source_type, sort_order, is_intercompany)
          VALUES
            (entity_rec.workspace_owner_id, entity_rec.id, 'Retail Cash',    'retail_cash',    1, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Card Terminal',  'card_terminal',  2, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Online / Other', 'online_other',   3, false),
            (entity_rec.workspace_owner_id, entity_rec.id, 'Bank Transfer',  'bank_transfer',  4, false)
          ON CONFLICT (workspace_owner_id, entity_id, name) DO NOTHING;
        END IF;
      END LOOP;

      -- Deactivate old generic sources on Lebanon entities (Presentail SAL) that are now superseded
      UPDATE accounting_sources
         SET is_active = false
       WHERE name IN ('Stripe', 'PayPal', 'Retail Cash', 'Card Terminal', 'Online / Other', 'Bank Transfer', 'Cash')
         AND entity_id IN (
           SELECT id FROM finance_entities
            WHERE country = 'LB'
               OR legal_name ILIKE '%SAL%'
               OR legal_name ILIKE '%Lebanon%'
         );

      -- Deactivate old generic sources on Cyprus/LTD entities (Presentail LTD) that are now superseded
      UPDATE accounting_sources
         SET is_active = false
       WHERE name IN ('Retail Cash', 'Card Terminal', 'Stripe', 'Online / Other', 'Bank Transfer', 'PayPal', 'Cash')
         AND entity_id IN (
           SELECT id FROM finance_entities
            WHERE country = 'CY'
               OR legal_name ILIKE '%LTD%'
               OR legal_name ILIKE '%Cyprus%'
         );
    END$$;
  `);
  logger.info("accounting_sources entity-specific seed ready");

  // Update Cyprus entity display_name to "Presentail LTD (Cyprus)" (idempotent)
  await db.query(`
    UPDATE finance_entities
       SET display_name = 'Presentail LTD (Cyprus)'
     WHERE (country = 'CY' OR legal_name ILIKE '%LTD%' OR legal_name ILIKE '%Cyprus%')
       AND (display_name IS NULL OR display_name NOT LIKE '%(Cyprus)%');
  `);
  logger.info("finance_entities Cyprus display_name ready");

  // ── Stripe reconciliation columns on source_statement_lines ─────────────────
  // external_ref: Stripe balance transaction ID (dedup key with source_month_id)
  // matched_order_id: OS order UUID when a charge matches an OS order
  // line_type: charge | refund | stripe_fee | dispute | payout | adjustment
  // match_confidence: high | medium | low | none
  await db.query(`ALTER TABLE source_statement_lines ADD COLUMN IF NOT EXISTS external_ref text`);
  await db.query(`ALTER TABLE source_statement_lines ADD COLUMN IF NOT EXISTS matched_order_id uuid`);
  await db.query(`ALTER TABLE source_statement_lines ADD COLUMN IF NOT EXISTS line_type text`);
  await db.query(`ALTER TABLE source_statement_lines ADD COLUMN IF NOT EXISTS match_confidence text`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_source_statement_lines_external_ref
      ON source_statement_lines(source_month_id, external_ref)
      WHERE external_ref IS NOT NULL
  `);
  logger.info("source_statement_lines stripe columns ready");

  // ── Stripe reconciliation columns on accounting_source_months ───────────────
  // sales_reconciliation_status: matched | partial | unmatched | pending
  // payout_reconciliation_status: matched | unmatched | unknown | pending
  // stripe_summary: jsonb blob with counts / amounts from the latest sync
  await db.query(`ALTER TABLE accounting_source_months ADD COLUMN IF NOT EXISTS sales_reconciliation_status text NOT NULL DEFAULT 'pending'`);
  await db.query(`ALTER TABLE accounting_source_months ADD COLUMN IF NOT EXISTS payout_reconciliation_status text NOT NULL DEFAULT 'pending'`);
  await db.query(`ALTER TABLE accounting_source_months ADD COLUMN IF NOT EXISTS stripe_summary jsonb`);
  logger.info("accounting_source_months stripe columns ready");

  // ── supplier_invoices extended columns (task #3258) ───────────────────────
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS due_date date`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS vat_amount numeric(14,4)`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS delivery_charge numeric(14,4)`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS discount numeric(14,4)`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS grand_total numeric(14,4)`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid'`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS file_urls jsonb`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS line_items jsonb`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS subtotal numeric(14,4)`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS payment_terms text`);
  logger.info("supplier_invoices extended columns ready");

  // ── purchase_order_invoices join table (task #3258) ───────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_order_invoices (
      id                   serial        PRIMARY KEY,
      purchase_order_id    integer       NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      supplier_invoice_id  integer       NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
      linked_at            timestamptz   NOT NULL DEFAULT now(),
      linked_by            text,
      notes                text,
      CONSTRAINT purchase_order_invoices_unique UNIQUE (purchase_order_id, supplier_invoice_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_poi_po ON purchase_order_invoices(purchase_order_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_poi_inv ON purchase_order_invoices(supplier_invoice_id);`);
  logger.info("purchase_order_invoices table ready");

  // ── purchase_orders.invoice_coverage_status (task #3258) ─────────────────
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_coverage_status text`);
  logger.info("purchase_orders.invoice_coverage_status column ready");

  // ── Address Collector — automated delivery-address collection ─────────────
  // One ACTIVE request per order (partial unique index); token stored only as
  // a SHA-256 hash; scheduled actions carry a unique idempotency key so the
  // worker can never double-send after a crash/restart.
  await db.query(`
    CREATE TABLE IF NOT EXISTS address_collection_requests (
      id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id      text        NOT NULL,
      order_id                uuid,
      recipient_name          text        NOT NULL,
      recipient_phone         text        NOT NULL,
      preferred_language      text        NOT NULL DEFAULT 'en',
      status                  text        NOT NULL DEFAULT 'awaiting_address',
      risk_level              text        NOT NULL DEFAULT 'normal',
      token_hash              text        NOT NULL,
      previous_token_hash     text,
      token_expires_at        timestamptz NOT NULL,
      window_start            timestamptz,
      window_end              timestamptz,
      address_deadline        timestamptz,
      delivery_timezone       text        NOT NULL DEFAULT 'Asia/Beirut',
      delivery_country_code   text,
      compliance_state        text        NOT NULL DEFAULT 'purchaser_toggle',
      sms_opt_out             boolean     NOT NULL DEFAULT false,
      manychat_subscriber_id  text,
      respondio_contact_id    text,
      respondio_channel_id    text,
      source                  text        NOT NULL DEFAULT 'order',
      submitted_address       jsonb,
      submitted_lat           double precision,
      submitted_lng           double precision,
      link_first_opened_at    timestamptz,
      last_contact_at         timestamptz,
      last_contact_channel    text,
      address_received_at     timestamptz,
      escalated_at            timestamptz,
      resolved_at             timestamptz,
      resolution_outcome      text,
      closure_reason          text,
      closure_source          text,
      closed_at               timestamptz,
       whatsapp_template_attempted_at timestamptz,
       whatsapp_template_provider_ref  text,
       whatsapp_template_status         text,
      cancelled_at            timestamptz,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    DROP INDEX IF EXISTS acr_one_active_per_order;
    CREATE UNIQUE INDEX IF NOT EXISTS acr_one_active_per_order_v2
      ON address_collection_requests(order_id)
      WHERE order_id IS NOT NULL
        AND status NOT IN ('resolved', 'address_received', 'verified', 'cancelled', 'expired');
  `);
  // respond.io contact id for outreach tracking (additive migration for
  // pre-existing DBs; the legacy manychat_subscriber_id column stays dormant).
  await db.query(`
  ALTER TABLE address_collection_requests ALTER COLUMN order_id DROP NOT NULL;
    ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS respondio_contact_id text;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS respondio_channel_id text;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'order';
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS delivery_country_code text;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS inbound_reply_type text;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS inbound_reply_text text;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS inbound_lat double precision;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS inbound_lng double precision;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS inbound_classifier jsonb;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS inbound_confidence double precision;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS inbound_outcome text;
  ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS inbound_error text;
   ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS whatsapp_template_attempted_at timestamptz;
   ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS whatsapp_template_provider_ref text;
   ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS whatsapp_template_status text;
   ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS resolution_outcome text;
   ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS closure_reason text;
   ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS closure_source text;
   ALTER TABLE address_collection_requests ADD COLUMN IF NOT EXISTS closed_at timestamptz;
  `);
  await db.query(`
    DROP INDEX IF EXISTS acr_one_active_per_order_v2;
    CREATE UNIQUE INDEX acr_one_active_per_order_v2
      ON address_collection_requests(order_id)
      WHERE order_id IS NOT NULL
        AND closed_at IS NULL
        AND status NOT IN ('resolved', 'address_received', 'verified', 'cancelled', 'expired');
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS acr_token_hash_unique ON address_collection_requests(token_hash);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_acr_workspace_status ON address_collection_requests(workspace_owner_id, status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_acr_order ON address_collection_requests(order_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_acr_respondio_contact ON address_collection_requests(workspace_owner_id, respondio_contact_id);`);
  await db.query(`
    DROP INDEX IF EXISTS acr_one_active_standalone_respondio_contact;
    CREATE UNIQUE INDEX IF NOT EXISTS acr_one_active_standalone_respondio_contact_v2
      ON address_collection_requests(workspace_owner_id, respondio_contact_id)
      WHERE source = 'respondio'
        AND respondio_contact_id IS NOT NULL
        AND closed_at IS NULL
        AND status NOT IN ('resolved', 'address_received', 'verified', 'cancelled', 'expired');
  `);
  logger.info("address_collection_requests table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS address_collection_actions (
      id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id       uuid        NOT NULL REFERENCES address_collection_requests(id) ON DELETE CASCADE,
      action_type      text        NOT NULL,
      channel          text        NOT NULL,
      scheduled_at     timestamptz NOT NULL,
      status           text        NOT NULL DEFAULT 'pending',
      idempotency_key  text        NOT NULL,
      attempt_count    integer     NOT NULL DEFAULT 0,
      triggering_rule  text,
      provider_ref     text,
      provider_status  text,
      sent_at          timestamptz,
      error_code       text,
      error_message    text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS aca_idempotency_key_unique ON address_collection_actions(idempotency_key);`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS aca_provider_ref_unique ON address_collection_actions(provider_ref) WHERE provider_ref IS NOT NULL;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_aca_due ON address_collection_actions(status, scheduled_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_aca_request ON address_collection_actions(request_id);`);
  logger.info("address_collection_actions table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS address_collection_events (
      id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id      uuid        NOT NULL REFERENCES address_collection_requests(id) ON DELETE CASCADE,
      event_type      text        NOT NULL,
      previous_state  text,
      new_state       text,
      actor           text        NOT NULL DEFAULT 'system',
      channel         text,
      provider_ref    text,
      metadata        jsonb,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ace_request_created ON address_collection_events(request_id, created_at);`);
  // Keep legacy repeat actions for auditability, but make them harmless before
  // any worker can claim them.
  await db.query(`
    WITH cancelled AS (
      UPDATE address_collection_actions
         SET status = 'cancelled',
             error_code = COALESCE(error_code, 'legacy_repeat_suppressed'),
             error_message = COALESCE(error_message, 'WhatsApp address outreach is limited to one template send'),
             updated_at = now()
       WHERE channel = 'whatsapp'
         AND action_type IN ('reminder', 'final_reminder', 'manual_reminder')
         AND status IN ('pending', 'processing')
       RETURNING request_id, action_type
    )
    INSERT INTO address_collection_events
      (request_id, event_type, actor, channel, metadata)
    SELECT request_id, 'whatsapp_outreach_suppressed', 'system', 'whatsapp',
           jsonb_build_object('action_type', action_type, 'reason', 'legacy_repeat_suppressed')
      FROM cancelled;
  `);
  logger.info("address_collection_events table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS address_collection_inbound_messages (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_message_id   text NOT NULL,
      channel_id            text,
      workspace_owner_id    text,
      request_id            uuid REFERENCES address_collection_requests(id) ON DELETE SET NULL,
      normalized_phone      text,
      reply_type            text NOT NULL,
      reply_text            text,
      latitude              double precision,
      longitude             double precision,
      classifier_result     jsonb,
      confidence            double precision,
      outcome               text,
      error_message         text,
      attempt_count        integer NOT NULL DEFAULT 0,
      processing_started_at timestamptz,
      next_attempt_at       timestamptz,
      claim_token           uuid,
      received_at           timestamptz NOT NULL DEFAULT now(),
      processed_at          timestamptz
    );
  `);
  await db.query(`
    ALTER TABLE address_collection_inbound_messages
      ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
    ALTER TABLE address_collection_inbound_messages
      ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;
    ALTER TABLE address_collection_inbound_messages
      ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
    ALTER TABLE address_collection_inbound_messages
      ADD COLUMN IF NOT EXISTS claim_token uuid;
  `);
  await db.query(`
    ALTER TABLE address_collection_inbound_messages ADD COLUMN IF NOT EXISTS channel_id text;
    ALTER TABLE address_collection_inbound_messages ADD COLUMN IF NOT EXISTS contact_id text;
    ALTER TABLE address_collection_inbound_messages ADD COLUMN IF NOT EXISTS reply_to_provider_ref text;
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS acim_provider_message_unique ON address_collection_inbound_messages(provider_message_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_acim_phone_received ON address_collection_inbound_messages(normalized_phone, received_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_acim_request_received ON address_collection_inbound_messages(request_id, received_at);`);
  logger.info("address_collection_inbound_messages table ready");

  // Idempotent rollout reconciliation. Historical requests retain all actions
  // and events; unresolved work is only marked closed/cancelled.
  await db.query(`
    WITH terminal AS (
      UPDATE address_collection_requests r
         SET status = CASE WHEN o.status IN ('cancelled','refunded') THEN 'cancelled' ELSE 'resolved' END,
             resolution_outcome = CASE WHEN o.status IN ('cancelled','refunded') THEN 'order_cancelled' ELSE 'order_delivered' END,
             closure_reason = CASE WHEN o.status IN ('cancelled','refunded') THEN 'Parent order cancelled or refunded' ELSE 'Parent order delivered or completed' END,
             closure_source = 'startup_reconciliation',
             closed_at = now(),
             cancelled_at = CASE WHEN o.status IN ('cancelled','refunded') THEN COALESCE(r.cancelled_at, now()) ELSE r.cancelled_at END,
             resolved_at = CASE WHEN o.status IN ('completed','delivered') THEN COALESCE(r.resolved_at, now()) ELSE r.resolved_at END,
             token_expires_at = LEAST(r.token_expires_at, now()),
             risk_level = 'normal',
             updated_at = now()
        FROM orders o
       WHERE r.order_id = o.id
         AND r.workspace_owner_id = o.workspace_owner_id
         AND o.status IN ('completed','delivered','cancelled','refunded')
         AND r.closed_at IS NULL
         AND r.status NOT IN ('resolved','address_received','verified','cancelled','expired')
       RETURNING r.id, r.status, r.resolution_outcome, r.closure_reason
    ),
    cancelled_actions AS (
      UPDATE address_collection_actions a
         SET status = 'cancelled',
             error_message = COALESCE(a.error_message, 'Parent order is terminal'),
             updated_at = now()
        FROM terminal t
       WHERE a.request_id = t.id
         AND a.status IN ('pending','processing','blocked')
       RETURNING a.request_id
    )
    INSERT INTO address_collection_events
      (request_id, event_type, new_state, actor, metadata)
    SELECT t.id, 'request_closed', t.status, 'system',
           jsonb_build_object(
             'outcome', t.resolution_outcome,
             'reason', t.closure_reason,
             'source', 'startup_reconciliation',
             'cancelled_actions', (SELECT count(*) FROM cancelled_actions c WHERE c.request_id = t.id)
           )
      FROM terminal t;
  `);
  logger.info("address collection terminal-order reconciliation complete");

  // ── One-time cleanup: remove duplicate auto-created workspace ──────────────
  await cleanupDuplicatePresentailWorkspace();

  // ── Backlink Engine tables ─────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_competitors (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      domain              text        NOT NULL,
      market              text        NOT NULL DEFAULT 'uae',
      active              boolean     NOT NULL DEFAULT true,
      last_synced_at      timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_competitors_workspace ON backlink_competitors(workspace_owner_id);`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_backlink_competitors_workspace_domain
      ON backlink_competitors(workspace_owner_id, domain);
  `);
  logger.info("backlink_competitors table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_opportunities (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      domain              text        NOT NULL,
      normalized_domain   text        NOT NULL,
      page_url            text        NOT NULL,
      opportunity_type    text,
      market              text        NOT NULL DEFAULT 'uae',
      source              text,
      destination_url     text,
      domain_authority    numeric(5,2),
      estimated_traffic   integer,
      spam_score          numeric(5,2),
      ai_score            numeric(5,2),
      ai_score_components jsonb,
      ai_explanation      text,
      status              text        NOT NULL DEFAULT 'discovered',
      owner_user_id       text,
      duplicate_of_id     integer,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      last_activity_at    timestamptz
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_opportunities_workspace ON backlink_opportunities(workspace_owner_id, status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_opportunities_score ON backlink_opportunities(workspace_owner_id, ai_score);`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_backlink_opportunities_dedup
      ON backlink_opportunities(workspace_owner_id, normalized_domain, page_url);
  `);
  logger.info("backlink_opportunities table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_contacts (
      id              serial      PRIMARY KEY,
      opportunity_id  integer     NOT NULL,
      name            text,
      role            text,
      email           text,
      confidence      numeric(5,2),
      source          text,
      do_not_contact  boolean     NOT NULL DEFAULT false,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_contacts_opportunity ON backlink_contacts(opportunity_id);`);
  logger.info("backlink_contacts table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_campaigns (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      name                text        NOT NULL,
      market              text,
      opportunity_type    text,
      target_url          text,
      content_asset       text,
      status              text        NOT NULL DEFAULT 'active',
      cooling_period_days integer     NOT NULL DEFAULT 30,
      max_followups       integer     NOT NULL DEFAULT 2,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_campaigns_workspace ON backlink_campaigns(workspace_owner_id);`);
  logger.info("backlink_campaigns table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_messages (
      id              serial      PRIMARY KEY,
      campaign_id     integer     NOT NULL,
      opportunity_id  integer     NOT NULL,
      contact_id      integer,
      subject         text,
      body            text,
      status          text        NOT NULL DEFAULT 'draft',
      approved_by     text,
      approved_at     timestamptz,
      sent_at         timestamptz,
      sequence_number integer     NOT NULL DEFAULT 1,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_messages_campaign ON backlink_messages(campaign_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_messages_opportunity ON backlink_messages(opportunity_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_messages_status ON backlink_messages(status, sent_at);`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_backlink_messages_dedup
      ON backlink_messages(contact_id, campaign_id, sequence_number)
      WHERE contact_id IS NOT NULL;
  `);
  logger.info("backlink_messages table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_links (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      opportunity_id      integer,
      source_url          text        NOT NULL,
      destination_url     text        NOT NULL,
      anchor_text         text,
      rel_type            text        NOT NULL DEFAULT 'follow',
      first_seen_at       timestamptz NOT NULL DEFAULT now(),
      last_checked_at     timestamptz,
      http_status         integer,
      status              text        NOT NULL DEFAULT 'live',
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_links_workspace ON backlink_links(workspace_owner_id, status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_links_check_due ON backlink_links(status, last_checked_at);`);
  logger.info("backlink_links table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_monitor_checks (
      id              serial      PRIMARY KEY,
      link_id         integer     NOT NULL,
      checked_at      timestamptz NOT NULL DEFAULT now(),
      http_status     integer,
      rel_type        text,
      anchor_text     text,
      destination_url text,
      status          text,
      notes           text
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_monitor_checks_link ON backlink_monitor_checks(link_id, checked_at);`);
  logger.info("backlink_monitor_checks table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_opportunity_notes (
      id              serial      PRIMARY KEY,
      opportunity_id  integer     NOT NULL,
      user_id         text        NOT NULL,
      body            text        NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_opportunity_notes_opp ON backlink_opportunity_notes(opportunity_id, created_at);`);
  logger.info("backlink_opportunity_notes table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_audit_events (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      entity_type         text        NOT NULL,
      entity_id           text        NOT NULL,
      action              text        NOT NULL,
      user_id             text,
      metadata            jsonb,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_audit_events_workspace ON backlink_audit_events(workspace_owner_id, created_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_audit_events_entity ON backlink_audit_events(entity_type, entity_id);`);
  logger.info("backlink_audit_events table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_job_runs (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      job_type            text        NOT NULL,
      status              text        NOT NULL DEFAULT 'running',
      started_at          timestamptz NOT NULL DEFAULT now(),
      finished_at         timestamptz,
      records_processed   integer     NOT NULL DEFAULT 0,
      error               text
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_job_runs_workspace ON backlink_job_runs(workspace_owner_id, job_type, started_at);`);
  logger.info("backlink_job_runs table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_suppression_list (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      email               text,
      domain              text,
      reason              text,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_backlink_suppression_workspace ON backlink_suppression_list(workspace_owner_id);`);
  logger.info("backlink_suppression_list table ready");

  // ── Inventory Ledger tables ────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id                  serial        PRIMARY KEY,
      workspace_owner_id  text          NOT NULL,
      base_item_id        integer       NOT NULL,
      location_id         integer,
      movement_type       text          NOT NULL,
      quantity_change     numeric(18,4) NOT NULL,
      unit_of_measure     text,
      unit_cost           numeric(14,4),
      total_value         numeric(14,4),
      currency            text          NOT NULL DEFAULT 'USD',
      fx_rate_to_usd      numeric(14,6),
      entity_id           text,
      source_type         text,
      source_id           text,
      source_label        text,
      employee_id         text,
      notes               text,
      posted_at           timestamptz   NOT NULL DEFAULT now(),
      created_at          timestamptz   NOT NULL DEFAULT now(),
      reversed_by_id      integer
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_inv_mov_workspace ON inventory_movements(workspace_owner_id, posted_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_inv_mov_base_item ON inventory_movements(base_item_id, posted_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_inv_mov_location ON inventory_movements(location_id, posted_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_inv_mov_source ON inventory_movements(source_type, source_id);`);
  logger.info("inventory_movements table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_location_costs (
      id                  serial        PRIMARY KEY,
      workspace_owner_id  text          NOT NULL,
      base_item_id        integer       NOT NULL,
      location_id         integer,
      weighted_avg_cost   numeric(14,4) NOT NULL DEFAULT 0,
      currency            text          NOT NULL DEFAULT 'USD',
      last_receipt_at     timestamptz,
      total_units_on_hand numeric(18,4) NOT NULL DEFAULT 0,
      updated_at          timestamptz   NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_bilc_workspace ON base_item_location_costs(workspace_owner_id);`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bilc_unique
      ON base_item_location_costs(base_item_id, location_id)
      NULLS NOT DISTINCT;
  `);
  logger.info("base_item_location_costs table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS wastage_records (
      id                  serial        PRIMARY KEY,
      workspace_owner_id  text          NOT NULL,
      base_item_id        integer       NOT NULL,
      location_id         integer,
      quantity            numeric(18,4) NOT NULL,
      unit_of_measure     text,
      reason              text          NOT NULL,
      employee_id         text,
      order_id            integer,
      notes               text,
      image_urls          jsonb,
      movement_id         integer,
      operational_movement_id integer REFERENCES base_item_stock_adjustments(id) ON DELETE SET NULL,
      created_at          timestamptz   NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    ALTER TABLE wastage_records
      ADD COLUMN IF NOT EXISTS operational_movement_id
        integer REFERENCES base_item_stock_adjustments(id) ON DELETE SET NULL
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wastage_workspace ON wastage_records(workspace_owner_id, created_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wastage_base_item ON wastage_records(base_item_id, created_at);`);
  logger.info("wastage_records table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_cogs_targets (
      id                  serial        PRIMARY KEY,
      workspace_owner_id  text          NOT NULL,
      entity_id           text,
      location_id         integer,
      target_cogs_pct     numeric(6,2)  NOT NULL,
      effective_from      timestamptz   NOT NULL DEFAULT now(),
      created_at          timestamptz   NOT NULL DEFAULT now(),
      updated_at          timestamptz   NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ict_workspace ON inventory_cogs_targets(workspace_owner_id);`);
  logger.info("inventory_cogs_targets table ready");

  await db.query(`ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS recipe_snapshot jsonb;`);
  logger.info("order_line_items.recipe_snapshot column ready");
  // ── End Inventory Ledger tables ────────────────────────────────────────────

  await db.query(`
    CREATE TABLE IF NOT EXISTS backlink_settings (
      id                      serial      PRIMARY KEY,
      workspace_owner_id      text        NOT NULL UNIQUE,
      seo_provider            text        NOT NULL DEFAULT 'stub',
      qualification_threshold integer     NOT NULL DEFAULT 70,
      scoring_weights         jsonb,
      followup_timing_days    jsonb,
      max_followups           integer     NOT NULL DEFAULT 2,
      daily_send_limit        integer     NOT NULL DEFAULT 20,
      cooling_period_days     integer     NOT NULL DEFAULT 30,
      discovery_job_cron      text        NOT NULL DEFAULT '0 3 * * *',
      monitor_job_cron        text        NOT NULL DEFAULT '0 4 * * 0',
      updated_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  logger.info("backlink_settings table ready");
  // ── End Backlink Engine tables ─────────────────────────────────────────────

  // ── supplier_assignments — many-to-many employee ownership ──────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_assignments (
      id                  serial PRIMARY KEY,
      supplier_id         integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      member_id           integer NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      workspace_owner_id  text    NOT NULL,
      is_lead             boolean NOT NULL DEFAULT false,
      created_by_clerk_id text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (supplier_id, member_id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_assignments_supplier ON supplier_assignments(supplier_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_assignments_member   ON supplier_assignments(member_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_assignments_workspace ON supplier_assignments(workspace_owner_id)`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_assignments_unique ON supplier_assignments(supplier_id, member_id)`);
  logger.info("supplier_assignments table ready");

  // ── supplier_activities — audit/activity log ────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_activities (
      id                 serial PRIMARY KEY,
      supplier_id        integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      workspace_owner_id text    NOT NULL,
      actor_clerk_id     text,
      action             text    NOT NULL,
      payload            jsonb,
      created_at         timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_activities_supplier  ON supplier_activities(supplier_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_activities_workspace ON supplier_activities(workspace_owner_id)`);
  logger.info("supplier_activities table ready");

  // ── purchase_orders — assignee & invoice-tracking columns ─────────────────
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_status text NOT NULL DEFAULT 'not_attached'`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS received_at timestamptz`);
  logger.info("purchase_orders invoice_status / received_at columns ready");

  // ── purchase_order_assignees ──────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_order_assignees (
      id                serial      PRIMARY KEY,
      purchase_order_id integer     NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      member_user_id    text        NOT NULL,
      assigned_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT po_assignee_unique UNIQUE (purchase_order_id, member_user_id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_po_assignees_po ON purchase_order_assignees(purchase_order_id)`);
  logger.info("purchase_order_assignees table ready");

  // ── supplier_default_assignees ────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_default_assignees (
      id                  serial      PRIMARY KEY,
      supplier_id         integer     NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      workspace_owner_id  text        NOT NULL,
      member_user_id      text        NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT supplier_default_assignee_unique UNIQUE (supplier_id, member_user_id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_default_assignees_supplier ON supplier_default_assignees(supplier_id)`);
  logger.info("supplier_default_assignees table ready");

  // ── base_item_stock_adjustments — ledger extension columns ─────────────────
  await db.query(`
    ALTER TABLE base_item_stock_adjustments
      ADD COLUMN IF NOT EXISTS order_id              text,
      ADD COLUMN IF NOT EXISTS order_line_item_id    text,
      ADD COLUMN IF NOT EXISTS product_id            integer REFERENCES products(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS idempotency_key       text,
      ADD COLUMN IF NOT EXISTS reversal_of_id        integer REFERENCES base_item_stock_adjustments(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS recipe_snapshot       jsonb,
      ADD COLUMN IF NOT EXISTS cutover_baseline      boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS ledger_scope          text NOT NULL DEFAULT 'base_item_operational',
      ADD COLUMN IF NOT EXISTS canonical_unit        text,
      ADD COLUMN IF NOT EXISTS base_item_name_snapshot text,
      ADD COLUMN IF NOT EXISTS location_name_snapshot text,
      ADD COLUMN IF NOT EXISTS actor_type            text,
      ADD COLUMN IF NOT EXISTS actor_id              text,
      ADD COLUMN IF NOT EXISTS actor_label_snapshot  text,
      ADD COLUMN IF NOT EXISTS source_type           text,
      ADD COLUMN IF NOT EXISTS source_id             text,
      ADD COLUMN IF NOT EXISTS source_label_snapshot text,
      ADD COLUMN IF NOT EXISTS reference_type        text,
      ADD COLUMN IF NOT EXISTS reference_id          text,
      ADD COLUMN IF NOT EXISTS reference_label_snapshot text,
      ADD COLUMN IF NOT EXISTS metadata_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb
  `);
  // Product-only CMC compatibility rows share the historical table but are not
  // Base Item operational movements and must never contribute to on-hand.
  await db.query(`
    UPDATE base_item_stock_adjustments
       SET ledger_scope = 'cmc_product_compat'
     WHERE (base_item_id IS NULL OR base_item_id = 0)
       AND ledger_scope <> 'cmc_product_compat'
  `);
  // Replace the old globally-scoped key with workspace-scoped idempotency once.
  // Do not rebuild the index on every startup.
  await db.query(`
    DO $$ DECLARE
      current_definition text;
    BEGIN
      SELECT indexdef INTO current_definition
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'base_item_stock_adj_idempotency';
      IF current_definition IS NOT NULL
         AND current_definition NOT LIKE '%(workspace_owner_id, idempotency_key)%'
      THEN
        DROP INDEX base_item_stock_adj_idempotency;
      END IF;
    END $$;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS base_item_stock_adj_idempotency
      ON base_item_stock_adjustments (workspace_owner_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
  // A second reversal is not safely recoverable by guessing which historical
  // entry is authoritative. Refuse the migration with an actionable error
  // rather than silently altering audit history or starting without the guard.
  await db.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT reversal_of_id
          FROM base_item_stock_adjustments
         WHERE reversal_of_id IS NOT NULL
           AND ledger_scope = 'base_item_operational'
         GROUP BY reversal_of_id
        HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION
          'Cannot create the operational reversal guard: duplicate reversals exist. Reconcile the affected Base Item movements before retrying initialization.';
      END IF;
    END $$;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS base_item_stock_adj_one_reversal
      ON base_item_stock_adjustments (reversal_of_id)
      WHERE reversal_of_id IS NOT NULL
        AND ledger_scope = 'base_item_operational'
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bisa_item_date_id
      ON base_item_stock_adjustments (base_item_id, created_at DESC, id DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bisa_item_loc_date_id
      ON base_item_stock_adjustments (base_item_id, location_id, created_at DESC, id DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bisa_order_id
      ON base_item_stock_adjustments (order_id)
      WHERE order_id IS NOT NULL
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bisa_purchase_order_id
      ON base_item_stock_adjustments (purchase_order_id)
      WHERE purchase_order_id IS NOT NULL
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bisa_transfer_id
      ON base_item_stock_adjustments (transfer_id)
      WHERE transfer_id IS NOT NULL
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bisa_reversal_of_id
      ON base_item_stock_adjustments (reversal_of_id)
      WHERE reversal_of_id IS NOT NULL
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bisa_movement_type
      ON base_item_stock_adjustments (movement_type)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bisa_ledger_scope
      ON base_item_stock_adjustments
         (workspace_owner_id, ledger_scope, created_at DESC)
  `);
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'base_item_operational_ledger_contract'
      ) THEN
        ALTER TABLE base_item_stock_adjustments
          ADD CONSTRAINT base_item_operational_ledger_contract
          CHECK (
            ledger_scope <> 'base_item_operational'
            OR (
              base_item_id IS NOT NULL
              AND location_id IS NOT NULL
              AND movement_type IS NOT NULL
              AND btrim(reason) <> ''
              AND canonical_unit IS NOT NULL
              AND base_item_name_snapshot IS NOT NULL
              AND location_name_snapshot IS NOT NULL
              AND actor_type IS NOT NULL
              AND source_type IS NOT NULL
              AND source_label_snapshot IS NOT NULL
              AND reference_type IS NOT NULL
              AND reference_label_snapshot IS NOT NULL
            )
          ) NOT VALID;
      END IF;
    END $$;
  `);
  logger.info("base_item_stock_adjustments ledger columns ready");

  // ── base_item_ledger_settings — cutover baseline per (base_item, location) ─
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_ledger_settings (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      base_item_id        integer     NOT NULL REFERENCES base_items(id) ON DELETE CASCADE,
      location_id         integer     NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      cutover_at          timestamptz NOT NULL,
      cutover_balance     numeric     NOT NULL,
      verified_by_user_id text        NOT NULL,
      verified_by_label_snapshot text,
      verification_reason text        NOT NULL,
      verified_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_owner_id, base_item_id, location_id)
    )
  `);
  await db.query(`
    ALTER TABLE base_item_ledger_settings
      ADD COLUMN IF NOT EXISTS verified_by_user_id text,
      ADD COLUMN IF NOT EXISTS verified_by_label_snapshot text,
      ADD COLUMN IF NOT EXISTS verification_reason text,
      ADD COLUMN IF NOT EXISTS verified_at timestamptz NOT NULL DEFAULT now()
  `);
  await db.query(`
    UPDATE base_item_ledger_settings
       SET verified_by_user_id = COALESCE(verified_by_user_id, 'legacy_cutover'),
           verification_reason = COALESCE(verification_reason, 'Legacy cutover baseline')
     WHERE verified_by_user_id IS NULL
        OR verification_reason IS NULL
  `);
  await db.query(`
    ALTER TABLE base_item_ledger_settings
      ALTER COLUMN verified_by_user_id SET NOT NULL,
      ALTER COLUMN verification_reason SET NOT NULL
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_bils_settings_workspace ON base_item_ledger_settings(workspace_owner_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_bils_settings_base_item ON base_item_ledger_settings(base_item_id)`);
  logger.info("base_item_ledger_settings table ready");

  // ── workspace_settings — inventory feature flags ──────────────────────────
  await db.query(`
    ALTER TABLE workspace_settings
      ADD COLUMN IF NOT EXISTS inventory_recipe_consumption_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS inventory_allow_negative_stock       boolean NOT NULL DEFAULT false
  `);
  logger.info("workspace_settings inventory columns ready");

  await db.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS inventory_fulfillment_cycle integer NOT NULL DEFAULT 0
  `);
  logger.info("orders.inventory_fulfillment_cycle column ready");

  // ── products.inventory_tracked ────────────────────────────────────────────
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_tracked boolean NOT NULL DEFAULT false`);
  await db.query(`
    UPDATE products SET inventory_tracked = true
     WHERE id IN (SELECT DISTINCT product_id FROM product_recipes)
       AND NOT inventory_tracked
  `);
  logger.info("products.inventory_tracked column ready");

  // ── purchase_order_receipt_events — idempotency anchors for PO receives ───
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_order_receipt_events (
      id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text        NOT NULL,
      purchase_order_id   integer     NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      location_id         integer     NOT NULL,
      received_by_user_id text,
      received_at         timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pore_po ON purchase_order_receipt_events(purchase_order_id)`);
  // Idempotency columns for PO receive
  await db.query(`
    ALTER TABLE purchase_order_receipt_events
      ADD COLUMN IF NOT EXISTS receive_action_id  uuid,
      ADD COLUMN IF NOT EXISTS payload_hash       text
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pore_workspace_action
      ON purchase_order_receipt_events (workspace_owner_id, receive_action_id)
      WHERE receive_action_id IS NOT NULL
  `);
  logger.info("purchase_order_receipt_events table ready");

  // ── recipe_consumption_exceptions — durable fulfilment review queue ───────
  await db.query(`
    CREATE TABLE IF NOT EXISTS recipe_consumption_exceptions (
      id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id    text        NOT NULL,
      order_id              text        NOT NULL,
      line_item_id          text        NOT NULL,
      base_item_id          integer,
      product_id            integer,
      location_id           integer,
      reason                text        NOT NULL,
      status                text        NOT NULL DEFAULT 'open',
      idempotency_key       text        NOT NULL,
      source_snapshot       jsonb       NOT NULL DEFAULT '{}'::jsonb,
      attempt_history       jsonb       NOT NULL DEFAULT '[]'::jsonb,
      resolved_movement_id  integer,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT recipe_consumption_exceptions_reason_check
        CHECK (reason IN (
          'MISSING_FULFILMENT_LOCATION',
          'MISSING_RECIPE',
          'MISSING_LEDGER_BASELINE',
          'INSUFFICIENT_STOCK',
          'UNSUPPORTED_UNIT_CONVERSION',
          'INTEGRITY_FAILURE'
        )),
      CONSTRAINT recipe_consumption_exceptions_status_check
        CHECK (status IN ('open', 'retrying', 'resolved')),
      CONSTRAINT recipe_consumption_exceptions_source_object_check
        CHECK (jsonb_typeof(source_snapshot) = 'object'),
      CONSTRAINT recipe_consumption_exceptions_attempt_array_check
        CHECK (jsonb_typeof(attempt_history) = 'array')
    )
  `);
  await db.query(`
    DROP INDEX IF EXISTS idx_rce_event_base_item
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rce_workspace_event_key
      ON recipe_consumption_exceptions (workspace_owner_id, idempotency_key)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_rce_workspace_status
      ON recipe_consumption_exceptions (workspace_owner_id, status, created_at DESC)
  `);
  logger.info("recipe_consumption_exceptions table ready");

  // ── journal_entry_drafts: entity-month link + approval fields (task #3195) ────
  await db.query(`ALTER TABLE journal_entry_drafts ADD COLUMN IF NOT EXISTS accounting_entity_month_id integer REFERENCES accounting_entity_months(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE journal_entry_drafts ADD COLUMN IF NOT EXISTS approved_by text`);
  await db.query(`ALTER TABLE journal_entry_drafts ADD COLUMN IF NOT EXISTS approved_at timestamptz`);
  await db.query(`ALTER TABLE journal_entry_drafts ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD'`);
  await db.query(`ALTER TABLE journal_entry_drafts ADD COLUMN IF NOT EXISTS reporting_currency text NOT NULL DEFAULT 'USD'`);
  await db.query(`ALTER TABLE journal_entry_drafts ADD COLUMN IF NOT EXISTS is_balanced boolean NOT NULL DEFAULT false`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entry_drafts_entity_month ON journal_entry_drafts(accounting_entity_month_id) WHERE accounting_entity_month_id IS NOT NULL`);
  logger.info("journal_entry_drafts extended columns ready");

  // ── journal_entry_lines: currency, FX, reporting amounts (task #3195) ────────
  await db.query(`ALTER TABLE journal_entry_lines ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD'`);
  await db.query(`ALTER TABLE journal_entry_lines ADD COLUMN IF NOT EXISTS exchange_rate numeric(14,6) NOT NULL DEFAULT 1`);
  await db.query(`ALTER TABLE journal_entry_lines ADD COLUMN IF NOT EXISTS reporting_debit_cents bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE journal_entry_lines ADD COLUMN IF NOT EXISTS reporting_credit_cents bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE journal_entry_lines ADD COLUMN IF NOT EXISTS line_type text`);
  await db.query(`ALTER TABLE journal_entry_lines ADD COLUMN IF NOT EXISTS source_id integer REFERENCES accounting_sources(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE journal_entry_lines ADD COLUMN IF NOT EXISTS source_name text`);
  logger.info("journal_entry_lines extended columns ready");

  // ── vat_summaries: per-source breakdown (task #3195) ─────────────────────────
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS source_id integer REFERENCES accounting_sources(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS source_name text`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD'`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS gross_incl_vat_cents bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS gross_excl_vat_cents bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS refund_vat_cents bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS fees_cents bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS vat_on_fees_cents bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS reporting_currency text NOT NULL DEFAULT 'USD'`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS reporting_gross_incl_vat_cents bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS reporting_gross_excl_vat_cents bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS reporting_vat_amount_cents bigint NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE vat_summaries ADD COLUMN IF NOT EXISTS reporting_refund_vat_cents bigint NOT NULL DEFAULT 0`);
  logger.info("vat_summaries extended columns ready");

  // ── accounting_sources.config already stores VAT + account code config ───────
  // The `config` jsonb column on accounting_sources is the canonical store;
  // GET/PATCH /accounting/sources/:id/config reads/writes it. No DDL needed.

  // ── base_item_stock_adjustments — adjustment_action_id for manual traceability ─
  await db.query(`
    ALTER TABLE base_item_stock_adjustments
      ADD COLUMN IF NOT EXISTS adjustment_action_id uuid
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bisa_adjustment_action_id
      ON base_item_stock_adjustments (workspace_owner_id, adjustment_action_id)
      WHERE adjustment_action_id IS NOT NULL
  `);
  logger.info("base_item_stock_adjustments adjustment_action_id ready");

  // ── base_item_cutover_runs — audit trail for cutover script executions ─────
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_item_cutover_runs (
      id                 serial       PRIMARY KEY,
      workspace_owner_id text         NOT NULL,
      base_item_id       integer,
      status             text         NOT NULL DEFAULT 'pending',
      started_at         timestamptz  NOT NULL DEFAULT now(),
      completed_at       timestamptz,
      total_pairs        integer,
      processed_pairs    integer,
      failed_pairs       integer,
      report_json        jsonb
    )
  `);
  await db.query(`
    ALTER TABLE base_item_cutover_runs
      ADD COLUMN IF NOT EXISTS base_item_id integer
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_bicr_workspace
      ON base_item_cutover_runs(workspace_owner_id, started_at DESC)
  `);
  logger.info("base_item_cutover_runs table ready");

  // ── purchase_order_acceptances — tokenized supplier acceptance workflow ─────
  await db.query(`
    CREATE TABLE IF NOT EXISTS purchase_order_acceptances (
      id                  serial      PRIMARY KEY,
      purchase_order_id   integer     NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      workspace_owner_id  text        NOT NULL,
      token               text        NOT NULL,
      status              text        NOT NULL DEFAULT 'pending',
      response_method     text,
      responder_name      text,
      responder_contact   text,
      responded_at        timestamptz,
      notes               text,
      po_version_hash     text,
      invalidated_at      timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_po_acceptances_token
      ON purchase_order_acceptances(token)
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_po_acceptances_po ON purchase_order_acceptances(purchase_order_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_po_acceptances_workspace ON purchase_order_acceptances(workspace_owner_id)`);
  logger.info("purchase_order_acceptances table ready");

  // ── purchase_orders — supplier acceptance columns ──────────────────────────
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS accepted_at timestamptz`);
  await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS acceptance_invalidated_at timestamptz`);
  logger.info("purchase_orders accepted_at / acceptance_invalidated_at columns ready");

  // ── products.is_cmc — CMC Beirut Hospital shelf product flag ─────────────
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_cmc boolean NOT NULL DEFAULT false`);
  logger.info("products.is_cmc column ready");

  // ── cmc_shifts — work shifts for CMC POS agents ───────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_shifts (
      id                  serial        PRIMARY KEY,
      workspace_owner_id  text          NOT NULL,
      location_id         integer       NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      opened_by_user_id   text          NOT NULL,
      closed_by_user_id   text,
      opened_at           timestamptz   NOT NULL DEFAULT now(),
      closed_at           timestamptz,
      status              text          NOT NULL DEFAULT 'open',
      totals_by_method    jsonb         NOT NULL DEFAULT '{}'
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_shifts_workspace ON cmc_shifts(workspace_owner_id, opened_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_shifts_location ON cmc_shifts(location_id, status)`);
  // ── Remediate pre-existing duplicate open shifts before enforcing uniqueness ──
  // Close all but the most recently opened shift per (workspace, user).
  // Idempotent: no-op when no duplicates exist.
  await db.query(`
    UPDATE cmc_shifts
       SET status = 'closed', closed_at = COALESCE(closed_at, now())
     WHERE status = 'open'
       AND id NOT IN (
         SELECT DISTINCT ON (workspace_owner_id, opened_by_user_id) id
           FROM cmc_shifts
          WHERE status = 'open'
          ORDER BY workspace_owner_id, opened_by_user_id, opened_at DESC NULLS LAST
       )
  `);
  // Enforce at most one open shift per user per workspace — DB-level backstop for the
  // per-user duplicate check in the shift-open route. Concurrent requests from the same
  // user that race past the pre-check are caught here and return 409.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cmc_shifts_one_open_per_user ON cmc_shifts(workspace_owner_id, opened_by_user_id) WHERE status = 'open'`);

  // ── cmc_sales — Workflow 1 shelf-sale transactions ────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_sales (
      id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text          NOT NULL,
      shift_id            integer       REFERENCES cmc_shifts(id) ON DELETE SET NULL,
      location_id         integer       REFERENCES locations(id) ON DELETE RESTRICT,
      created_by_user_id  text          NOT NULL,
      workflow_type       text          NOT NULL DEFAULT 'shelf_sale',
      source_channel      text          NOT NULL DEFAULT 'cmc-pos',
      status              text          NOT NULL DEFAULT 'paid',
      customer_contact_id uuid,
      line_items          jsonb         NOT NULL DEFAULT '[]',
      subtotal            numeric(14,4) NOT NULL DEFAULT 0,
      discount_amount     numeric(14,4) NOT NULL DEFAULT 0,
      tax_amount          numeric(14,4) NOT NULL DEFAULT 0,
      total               numeric(14,4) NOT NULL DEFAULT 0,
      payment_method      text,
      payment_reference   text,
      notes               text,
      idempotency_key     text,
      created_at          timestamptz   NOT NULL DEFAULT now(),
      updated_at          timestamptz   NOT NULL DEFAULT now()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_sales_workspace ON cmc_sales(workspace_owner_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_sales_shift ON cmc_sales(shift_id) WHERE shift_id IS NOT NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_sales_location ON cmc_sales(location_id, created_at DESC)`);
  await db.query(`ALTER TABLE cmc_sales ADD COLUMN IF NOT EXISTS fulfilment_date date`);
  await db.query(`ALTER TABLE cmc_sales ADD COLUMN IF NOT EXISTS fulfilment_date_to date`);
  await db.query(`ALTER TABLE cmc_sales ADD COLUMN IF NOT EXISTS receipt_image_url text`);
  // Total-level discount (percent/amount on the combined subtotal) with a
  // free-text reason. discount_amount stays the computed dollar amount.
  await db.query(`ALTER TABLE cmc_sales ADD COLUMN IF NOT EXISTS discount_type text`);
  await db.query(`ALTER TABLE cmc_sales ADD COLUMN IF NOT EXISTS discount_value numeric(14,4)`);
  await db.query(`ALTER TABLE cmc_sales ADD COLUMN IF NOT EXISTS discount_description text`);
  // CMC New Order records (workflow_type = 'order') link back to the orders
  // row created by the CMC New Order page. Such records carry no POS location
  // (orders don't have one at creation time), so location_id is nullable.
  await db.query(`ALTER TABLE cmc_sales ADD COLUMN IF NOT EXISTS order_id uuid`);
  await db.query(`ALTER TABLE cmc_sales ALTER COLUMN location_id DROP NOT NULL`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cmc_sales_order_unique
      ON cmc_sales(order_id)
      WHERE order_id IS NOT NULL
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cmc_sales_idempotency_unique
      ON cmc_sales(workspace_owner_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);

  // Idempotent backfill (Aug 2026): every cmc-pos-sourced order must have a
  // linked cmc_sales row (workflow_type='order'). New orders get it atomically
  // in orderCreate.ts; this repairs orders that predate the linking (or were
  // mis-sourced, e.g. M-1063) so they appear in CMC daily sales totals.
  await backfillCmcOrderSales();

  // ── cmc_requests — Workflow 2 branch product requests ─────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_requests (
      id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id      text        NOT NULL,
      destination_location_id integer     NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      purpose                 text        NOT NULL DEFAULT 'for_customer',
      customer_contact_id     uuid,
      status                  text        NOT NULL DEFAULT 'draft',
      priority                text        NOT NULL DEFAULT 'standard',
      needed_by               timestamptz,
      notes                   text,
      created_by_user_id      text        NOT NULL,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_requests_workspace ON cmc_requests(workspace_owner_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_requests_location ON cmc_requests(destination_location_id, status)`);

  // ── cmc_request_line_items — line items per branch request ────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_request_line_items (
      id                 serial        PRIMARY KEY,
      request_id         uuid          NOT NULL REFERENCES cmc_requests(id) ON DELETE CASCADE,
      product_id         integer,
      source_location_id integer       REFERENCES locations(id) ON DELETE SET NULL,
      requested_qty      integer       NOT NULL DEFAULT 1,
      accepted_qty       integer,
      received_qty       integer,
      unit_price         numeric(14,4),
      notes              text
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_rli_request ON cmc_request_line_items(request_id)`);

  // ── cmc_request_events — status-change audit trail ────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_request_events (
      id              serial      PRIMARY KEY,
      request_id      uuid        NOT NULL REFERENCES cmc_requests(id) ON DELETE CASCADE,
      actor_user_id   text,
      from_status     text,
      to_status       text        NOT NULL,
      notes           text,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_re_request ON cmc_request_events(request_id, created_at DESC)`);

  // ── cmc_order_counters — per-workspace CMC delivery order sequence ─────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_order_counters (
      workspace_owner_id  text    NOT NULL,
      seq                 integer NOT NULL DEFAULT 1001
    )
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cmc_order_counters_workspace
      ON cmc_order_counters(workspace_owner_id)
  `);
  await db.query(`ALTER TABLE cmc_request_line_items ADD COLUMN IF NOT EXISTS name text`);
  await db.query(`ALTER TABLE cmc_request_line_items ADD COLUMN IF NOT EXISTS image_url text`);
  await db.query(`ALTER TABLE cmc_request_line_items ADD COLUMN IF NOT EXISTS description text`);
  await db.query(`ALTER TABLE cmc_requests ADD COLUMN IF NOT EXISTS source_location_id integer REFERENCES locations(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE cmc_requests ADD COLUMN IF NOT EXISTS tookan_job_id  text`);
  await db.query(`ALTER TABLE cmc_requests ADD COLUMN IF NOT EXISTS tookan_task_id text`);

  // ── cmc_monthly_settlements — payment status per workspace per month ──────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_monthly_settlements (
      id                  serial        PRIMARY KEY,
      workspace_owner_id  text          NOT NULL,
      settlement_month    char(7)       NOT NULL,
      currency            text          NOT NULL DEFAULT 'USD',
      status              text          NOT NULL DEFAULT 'unpaid',
      paid_at             timestamptz,
      paid_by_user_id     text,
      updated_at          timestamptz   NOT NULL DEFAULT now(),
      updated_by_user_id  text,
      CONSTRAINT cmc_monthly_settlements_workspace_month UNIQUE (workspace_owner_id, settlement_month)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_settlements_workspace ON cmc_monthly_settlements(workspace_owner_id, settlement_month DESC)`);
  // Extended payment recording fields — idempotent
  await db.query(`ALTER TABLE cmc_monthly_settlements ADD COLUMN IF NOT EXISTS payment_method    text`);
  await db.query(`ALTER TABLE cmc_monthly_settlements ADD COLUMN IF NOT EXISTS reference_number  text`);
  await db.query(`ALTER TABLE cmc_monthly_settlements ADD COLUMN IF NOT EXISTS payment_note      text`);
  await db.query(`ALTER TABLE cmc_monthly_settlements ADD COLUMN IF NOT EXISTS payment_amount    numeric(14,4)`);
  logger.info("cmc_monthly_settlements extended payment columns ready");

  // ── cmc_monthly_settlement_audit — audit log for status changes ───────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_monthly_settlement_audit (
      id                  serial        PRIMARY KEY,
      workspace_owner_id  text          NOT NULL,
      settlement_month    char(7)       NOT NULL,
      from_status         text,
      to_status           text          NOT NULL,
      actor_user_id       text,
      created_at          timestamptz   NOT NULL DEFAULT now()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_settlement_audit_workspace ON cmc_monthly_settlement_audit(workspace_owner_id, settlement_month DESC)`);

  // ── cmc_monthly_report_deliveries — email delivery tracking ──────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_monthly_report_deliveries (
      id                  serial        PRIMARY KEY,
      workspace_owner_id  text          NOT NULL,
      report_month        char(7)       NOT NULL,
      recipient_user_id   text          NOT NULL,
      recipient_email     text          NOT NULL,
      status              text          NOT NULL DEFAULT 'pending',
      provider_message_id text,
      attempt_count       integer       NOT NULL DEFAULT 0,
      last_attempt_at     timestamptz,
      sent_at             timestamptz,
      failure_reason      text,
      created_at          timestamptz   NOT NULL DEFAULT now(),
      CONSTRAINT cmc_monthly_report_deliveries_unique UNIQUE (workspace_owner_id, report_month, recipient_user_id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_report_deliveries_workspace ON cmc_monthly_report_deliveries(workspace_owner_id, report_month)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_report_deliveries_status ON cmc_monthly_report_deliveries(status, last_attempt_at)`);

  // ── cmc_shifts cash session columns ──────────────────────────────────────
  // cash_session_id: FK to the cash session auto-opened when this shift starts.
  await db.query(`ALTER TABLE cmc_shifts ADD COLUMN IF NOT EXISTS cash_session_id integer REFERENCES cash_sessions(id) ON DELETE SET NULL`);
  // opening_cash: mirrors cash session opening_cash for reconciliation display.
  await db.query(`ALTER TABLE cmc_shifts ADD COLUMN IF NOT EXISTS opening_cash numeric(14,2) NOT NULL DEFAULT 0`);
  // Closing reconciliation fields stored for audit trail.
  await db.query(`ALTER TABLE cmc_shifts ADD COLUMN IF NOT EXISTS closing_cash_kept numeric(14,2)`);
  await db.query(`ALTER TABLE cmc_shifts ADD COLUMN IF NOT EXISTS closing_cash_transferred numeric(14,2)`);
  await db.query(`ALTER TABLE cmc_shifts ADD COLUMN IF NOT EXISTS closing_destination_location_id integer REFERENCES locations(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE cmc_shifts ADD COLUMN IF NOT EXISTS discrepancy_note text`);
  // Chosen transaction currency for dual-currency drawer shifts (e.g. USD or LBP when
  // the drawer accepts both). Single-currency shifts leave this NULL; reconciliation
  // falls back to summing all cash_transactions for the session when NULL.
  await db.query(`ALTER TABLE cmc_shifts ADD COLUMN IF NOT EXISTS currency text`);
  // Whish wallet transfer amount recorded at shift close (primary currency only).
  await db.query(`ALTER TABLE cmc_shifts ADD COLUMN IF NOT EXISTS closing_whish_transferred NUMERIC(12,2) NOT NULL DEFAULT 0`);
  logger.info("cmc_shifts cash session columns ready");

  // ── cash_transactions transfer_id — links paired inter-location transfers ─
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS transfer_id text`);
  logger.info("cash_transactions.transfer_id column ready");

  // ── Idempotency index for CMC cash sale ledger entries ────────────────────
  // Ensures one cash_transaction per CMC sale (reference_id = sale UUID).
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'cash_transactions'
            AND indexname  = 'idx_cash_txn_cmc_sale_unique'
       ) AS exists`,
    );
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_txn_cmc_sale_unique
        ON cash_transactions(workspace_owner_id, reference_id)
        WHERE type = 'cash_sale' AND reference_id IS NOT NULL
    `);
    if (existsBefore.rows[0].exists) {
      logger.info("idx_cash_txn_cmc_sale_unique: already present — no action needed");
    } else {
      logger.info("idx_cash_txn_cmc_sale_unique: was missing — created successfully");
    }
  }

  logger.info("CMC POS tables ready");

  // ── merchant_sync_jobs — durable queue for Google Merchant Center sync ──────
  await db.query(`
    CREATE TABLE IF NOT EXISTS merchant_sync_jobs (
      id          bigserial    PRIMARY KEY,
      product_id  integer      REFERENCES products(id) ON DELETE SET NULL,
      operation   text         NOT NULL,
      status      text         NOT NULL DEFAULT 'PENDING',
      attempts    integer      NOT NULL DEFAULT 0,
      last_error  text,
      payload     jsonb        NOT NULL DEFAULT '{}',
      next_retry_at  timestamptz,
      completed_at   timestamptz,
      created_at  timestamptz  NOT NULL DEFAULT now(),
      updated_at  timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT merchant_sync_jobs_operation_check
        CHECK (operation IN ('CREATE_OR_UPDATE', 'DELETE')),
      CONSTRAINT merchant_sync_jobs_status_check
        CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRY_WAITING'))
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_msj_status_next_retry
      ON merchant_sync_jobs (status, next_retry_at)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_msj_product
      ON merchant_sync_jobs (product_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_msj_created
      ON merchant_sync_jobs (created_at)
  `);
  // Keep only the newest active CREATE_OR_UPDATE job before creating the
  // uniqueness invariant. These jobs are process-time reads, so superseding a
  // duplicate stale job never loses a product payload.
  await db.query(`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY product_id
               ORDER BY updated_at DESC, created_at DESC, id DESC
             ) AS position
        FROM merchant_sync_jobs
       WHERE operation = 'CREATE_OR_UPDATE'
         AND status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
         AND product_id IS NOT NULL
    )
    UPDATE merchant_sync_jobs j
       SET status = 'FAILED',
           last_error = 'Superseded by a newer active Merchant Center sync job',
           updated_at = now()
      FROM ranked r
     WHERE j.id = r.id
       AND r.position > 1
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_msj_one_active_create_per_product
      ON merchant_sync_jobs (product_id)
      WHERE operation = 'CREATE_OR_UPDATE'
        AND status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
  `);
  // DELETE is idempotent at the product level too. Remove any legacy
  // duplicates before creating the active-delete uniqueness invariant.
  await db.query(`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY product_id
               ORDER BY updated_at DESC, created_at DESC, id DESC
             ) AS position
        FROM merchant_sync_jobs
       WHERE operation = 'DELETE'
         AND status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
         AND product_id IS NOT NULL
    )
    UPDATE merchant_sync_jobs j
       SET status = 'FAILED',
           last_error = 'Superseded by a newer active Merchant Center delete job',
           updated_at = now()
      FROM ranked r
     WHERE j.id = r.id
       AND r.position > 1
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_msj_one_active_delete_per_product
      ON merchant_sync_jobs (product_id)
      WHERE operation = 'DELETE'
        AND status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
  `);
  logger.info("merchant_sync_jobs table ready");

  // Phase 1 Merchant ownership and reconciliation. target_country on products
  // is intentionally not dropped: old deployments may still read it, while all
  // new Merchant code uses the offer's explicit country/language identity.
  await db.query(`
    CREATE TABLE IF NOT EXISTS merchant_offer_states (
      workspace_owner_id text NOT NULL,
      product_id integer NOT NULL,
      country text NOT NULL,
      content_language text NOT NULL,
      offer_id text NOT NULL,
      account_id text NOT NULL,
      data_source_id text NOT NULL,
      data_source_name text NOT NULL,
      merchant_resource_name text,
      sync_status text NOT NULL DEFAULT 'PENDING', payload_hash text, payload_snapshot jsonb,
      last_error text, last_synced_at timestamptz, last_attempt_at timestamptz,
      is_owned boolean NOT NULL DEFAULT true,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (workspace_owner_id, product_id, country, content_language, account_id, data_source_id, offer_id)
    )
  `);
  // An offer is owned by an account/data-source identity, not merely by its
  // market.  Keep the old and target LB identities concurrently during an
  // account migration so a source deletion can never overwrite its replacement.
  //
  // Do not use DROP CONSTRAINT IF EXISTS here. Older deployments can have a
  // primary key with a non-standard name, and dropping only the conventional
  // name followed by an unconditional ADD PRIMARY KEY is what caused
  // "multiple primary keys for table merchant_offer_states are not allowed".
  // The contract is semantic: the key must be a PostgreSQL PRIMARY KEY with
  // this exact ordered column list. A differently named equivalent key is
  // already valid and must be left unchanged; an unexpected key is a manual
  // migration case, never an automatic destructive repair.
  const expectedMerchantOfferStatePk = [
    "workspace_owner_id",
    "product_id",
    "country",
    "content_language",
    "account_id",
    "data_source_id",
    "offer_id",
  ] as const;
  const merchantOfferStateColumns = await db.query<{
    attname: string;
    attnotnull: boolean;
  }>(
    `SELECT attname, attnotnull
       FROM pg_attribute
      WHERE attrelid = 'public.merchant_offer_states'::regclass
        AND attnum > 0
        AND NOT attisdropped
        AND attname = ANY($1::text[])
      ORDER BY array_position($1::text[], attname)`,
    [expectedMerchantOfferStatePk],
  );
  const missingMerchantOfferStateColumns = expectedMerchantOfferStatePk.filter(
    (column) => !merchantOfferStateColumns.rows.some((row) => row.attname === column),
  );
  if (missingMerchantOfferStateColumns.length > 0) {
    throw new Error(
      `merchant_offer_states cannot validate its primary key: missing expected columns ` +
      `${missingMerchantOfferStateColumns.join(", ")}. ` +
      `Restore those columns and their data before retrying initialization.`,
    );
  }

  const merchantOfferStatePrimaryKeys = await db.query<{
    constraint_name: string;
    constraint_type: string;
    columns: string[];
  }>(
    `SELECT c.conname AS constraint_name,
            c.contype AS constraint_type,
            ARRAY_AGG(a.attname::text ORDER BY key_columns.ordinality)::text[] AS columns
       FROM pg_constraint c
       JOIN LATERAL unnest(c.conkey) WITH ORDINALITY
            AS key_columns(attnum, ordinality) ON true
       JOIN pg_attribute a
         ON a.attrelid = c.conrelid
        AND a.attnum = key_columns.attnum
      WHERE c.conrelid = 'public.merchant_offer_states'::regclass
        AND c.contype = 'p'
      GROUP BY c.conname, c.contype`,
  );
  const existingMerchantOfferStatePk = merchantOfferStatePrimaryKeys.rows[0];
  if (existingMerchantOfferStatePk) {
    const matchesExpectedMerchantOfferStatePk =
      existingMerchantOfferStatePk.constraint_type === "p"
      && existingMerchantOfferStatePk.columns.length === expectedMerchantOfferStatePk.length
      && existingMerchantOfferStatePk.columns.every(
        (column, index) => column === expectedMerchantOfferStatePk[index],
      );
    if (matchesExpectedMerchantOfferStatePk) {
      logger.info(
        {
          constraintName: existingMerchantOfferStatePk.constraint_name,
          columns: existingMerchantOfferStatePk.columns,
        },
        "merchant_offer_states primary key already satisfies the expected contract",
      );
    } else {
      throw new Error(
        `merchant_offer_states has an unexpected primary key ` +
        `"${existingMerchantOfferStatePk.constraint_name}" ` +
        `(${existingMerchantOfferStatePk.columns.join(", ")}); expected ` +
        `(${expectedMerchantOfferStatePk.join(", ")}). ` +
        `No constraint was changed; resolve this schema mismatch manually.`,
      );
    }
  } else {
    const duplicateOrNullGroups = await db.query<{
      duplicate_groups: number;
      null_groups: number;
      offending_groups: unknown;
    }>(
      `SELECT COUNT(*) FILTER (WHERE row_count > 1)::int AS duplicate_groups,
              COUNT(*) FILTER (
                WHERE workspace_owner_id IS NULL
                   OR product_id IS NULL
                   OR country IS NULL
                   OR content_language IS NULL
                   OR account_id IS NULL
                   OR data_source_id IS NULL
                   OR offer_id IS NULL
              )::int AS null_groups,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'workspace_owner_id', workspace_owner_id,
                    'product_id', product_id,
                    'country', country,
                    'content_language', content_language,
                    'account_id', account_id,
                    'data_source_id', data_source_id,
                    'offer_id', offer_id,
                    'row_count', row_count
                  )
                  ORDER BY row_count DESC
                ) FILTER (
                  WHERE row_count > 1
                     OR workspace_owner_id IS NULL
                     OR product_id IS NULL
                     OR country IS NULL
                     OR content_language IS NULL
                     OR account_id IS NULL
                     OR data_source_id IS NULL
                     OR offer_id IS NULL
                ),
                '[]'::jsonb
              ) AS offending_groups
         FROM (
           SELECT workspace_owner_id, product_id, country, content_language,
                  account_id, data_source_id, offer_id, COUNT(*)::int AS row_count
             FROM merchant_offer_states
            GROUP BY workspace_owner_id, product_id, country, content_language,
                     account_id, data_source_id, offer_id
         ) grouped_keys`,
    );
    const invalidMerchantOfferStateKeys = duplicateOrNullGroups.rows[0];
    if (
      (invalidMerchantOfferStateKeys?.duplicate_groups ?? 0) > 0
      || (invalidMerchantOfferStateKeys?.null_groups ?? 0) > 0
    ) {
      throw new Error(
        `merchant_offer_states cannot create the expected primary key because ` +
        `${invalidMerchantOfferStateKeys?.duplicate_groups ?? 0} duplicate key group(s) ` +
        `and ${invalidMerchantOfferStateKeys?.null_groups ?? 0} null-containing key group(s) ` +
        `exist. Offending key summary: ` +
        `${JSON.stringify(invalidMerchantOfferStateKeys?.offending_groups ?? [])}. ` +
        `Resolve the rows manually, then retry initialization; no rows were changed.`,
      );
    }
    await db.query(
      `ALTER TABLE merchant_offer_states
         ADD CONSTRAINT merchant_offer_states_pkey
         PRIMARY KEY (workspace_owner_id, product_id, country, content_language,
                      account_id, data_source_id, offer_id)`,
    );
    logger.info(
      { columns: expectedMerchantOfferStatePk },
      "merchant_offer_states primary key created",
    );
  }
  await db.query(`ALTER TABLE merchant_offer_states ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'PENDING', ADD COLUMN IF NOT EXISTS payload_hash text, ADD COLUMN IF NOT EXISTS payload_snapshot jsonb, ADD COLUMN IF NOT EXISTS last_error text, ADD COLUMN IF NOT EXISTS last_synced_at timestamptz, ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz, ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'PENDING', ADD COLUMN IF NOT EXISTS approval_evidence jsonb, ADD COLUMN IF NOT EXISTS approval_checked_at timestamptz, ADD COLUMN IF NOT EXISTS approval_deadline_at timestamptz`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_offer_states_offer ON merchant_offer_states(account_id, offer_id, country, content_language)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS merchant_reconciliation_runs (
      id bigserial PRIMARY KEY, workspace_owner_id text NOT NULL, country text NOT NULL,
      content_language text NOT NULL, status text NOT NULL DEFAULT 'DRAFT',
      summary jsonb NOT NULL DEFAULT '{}', created_by text NOT NULL,
      approved_at timestamptz, approved_by text, applied_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`ALTER TABLE merchant_reconciliation_runs ADD COLUMN IF NOT EXISTS approved_by text`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS merchant_reconciliation_items (
      id bigserial PRIMARY KEY, run_id bigint NOT NULL REFERENCES merchant_reconciliation_runs(id) ON DELETE CASCADE,
      product_id integer, country text NOT NULL,
      content_language text NOT NULL, offer_id text NOT NULL, action text NOT NULL,
      reason text, state_identity jsonb, delete_approved boolean NOT NULL DEFAULT false,
      last_offer_approved boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`DROP INDEX IF EXISTS idx_merchant_reconciliation_item_offer`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_reconciliation_item_identity
    ON merchant_reconciliation_items(
      run_id, action, offer_id,
      (COALESCE(state_identity->>'accountId','')),
      (COALESCE(state_identity->>'dataSourceId',''))
    )`);
  // Existing installations created by an early Phase 1 build may have FKs that
  // erase ownership/audit data on product hard delete. Remove only those FKs.
  await db.query(`DO $$ DECLARE c record; BEGIN
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='merchant_offer_states'::regclass AND contype='f' LOOP
      EXECUTE format('ALTER TABLE merchant_offer_states DROP CONSTRAINT %I', c.conname); END LOOP;
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='merchant_reconciliation_items'::regclass AND contype='f' AND confrelid='products'::regclass LOOP
      EXECUTE format('ALTER TABLE merchant_reconciliation_items DROP CONSTRAINT %I', c.conname); END LOOP;
  END $$`);
  // offer-scoped job identity; legacy product-scoped indexes remain harmless
  // during rollout and are not used by guarded DELETE creation.
  await db.query(`ALTER TABLE merchant_sync_jobs ADD COLUMN IF NOT EXISTS offer_country text`);
  await db.query(`ALTER TABLE merchant_sync_jobs ADD COLUMN IF NOT EXISTS offer_content_language text`);
  await db.query(`ALTER TABLE merchant_sync_jobs ADD COLUMN IF NOT EXISTS reconciliation_item_id bigint REFERENCES merchant_reconciliation_items(id)`);
  await db.query(`ALTER TABLE merchant_sync_jobs ADD COLUMN IF NOT EXISTS depends_on_job_id bigint REFERENCES merchant_sync_jobs(id)`);
  await db.query(`DROP INDEX IF EXISTS idx_msj_active_offer_operation`);
  await db.query(`ALTER TABLE merchant_sync_jobs DROP CONSTRAINT IF EXISTS merchant_sync_jobs_status_check`);
  await db.query(`ALTER TABLE merchant_sync_jobs ADD CONSTRAINT merchant_sync_jobs_status_check CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','RETRY_WAITING','CANCELLED','WAITING_DEPENDENCY'))`);
  await db.query(`WITH ranked AS (
    SELECT id,ROW_NUMBER() OVER (PARTITION BY product_id,offer_country,offer_content_language
      ORDER BY CASE operation WHEN 'DELETE' THEN 0 ELSE 1 END, updated_at DESC,id DESC) n
    FROM merchant_sync_jobs WHERE status IN ('PENDING','RUNNING','RETRY_WAITING')
      AND offer_country IS NOT NULL AND offer_content_language IS NOT NULL)
    UPDATE merchant_sync_jobs j SET status='CANCELLED',last_error='Superseded while enforcing offer-level operation serialization',updated_at=now()
    FROM ranked r WHERE j.id=r.id AND r.n>1 AND j.status<>'RUNNING'`);
  await db.query(`UPDATE merchant_sync_jobs j SET status='CANCELLED',last_error='Superseded by RUNNING offer operation during serialization migration',updated_at=now()
    WHERE j.status IN ('PENDING','RETRY_WAITING') AND EXISTS (
      SELECT 1 FROM merchant_sync_jobs r WHERE r.id<>j.id AND r.product_id=j.product_id
        AND r.offer_country=j.offer_country AND r.offer_content_language=j.offer_content_language AND r.status='RUNNING')`);
  await db.query(`DO $$ BEGIN IF EXISTS (
    SELECT 1 FROM merchant_sync_jobs WHERE status='RUNNING' AND offer_country IS NOT NULL
    GROUP BY product_id,offer_country,offer_content_language HAVING COUNT(*)>1
  ) THEN RAISE EXCEPTION 'Unsafe duplicate RUNNING Merchant jobs exist for one offer'; END IF; END $$`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_msj_one_active_per_offer ON merchant_sync_jobs(product_id, offer_country, offer_content_language) WHERE status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')`);
  await db.query(`DROP INDEX IF EXISTS idx_msj_one_active_create_per_product`);
  await db.query(`DROP INDEX IF EXISTS idx_msj_one_active_delete_per_product`);

  // One-off backfill: clear double-prefixed image_url values on order_line_items
  // so the server-side enrichment in the order detail route can re-resolve them
  // from the products table. Rows affected are those created by the manual-order
  // wizard before the imageUrl() helper was removed from the save path, where
  // image_url was stored as "/api/storage/objects/…" instead of being left null.
  // Idempotent: rows already null or resolved to non-/api/storage paths are untouched.
  await db.query(`
    UPDATE order_line_items
       SET image_url = NULL
     WHERE product_id IS NOT NULL
       AND image_url LIKE '/api/storage/%'
  `);
  logger.info("order_line_items double-prefix image_url backfill complete");

  // ── Address Book ─────────────────────────────────────────────────────────────
  // Verification state is enforced as a PostgreSQL custom type so DB-level
  // constraints apply. Created idempotently via DO $$ EXCEPTION WHEN … END $$.
  await db.query(`
    DO $$ BEGIN
      CREATE TYPE place_verification_state AS ENUM (
        'unverified', 'estimated', 'ai_verified', 'staff_verified', 'delivery_verified'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await db.query(`
    ALTER TYPE place_verification_state ADD VALUE IF NOT EXISTS 'ai_verified';
  `);

  // places — canonical delivery locations shared across the workspace.
  await db.query(`
    CREATE TABLE IF NOT EXISTS places (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text NOT NULL,
      canonical_name      text NOT NULL,
       canonical_name_source text NOT NULL DEFAULT 'manual',
      place_type          text NOT NULL DEFAULT 'residence',
      area                text,
      city_id             integer REFERENCES delivery_cities(id) ON DELETE SET NULL,
      trusted_country_code text,
      trusted_country_source text,
      canonical_address   text,
      latitude            numeric(10, 7),
      longitude           numeric(10, 7),
      entrance_notes      text,
      internal_notes      text,
      verification_state  place_verification_state NOT NULL DEFAULT 'unverified',
      archived_at         timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT places_workspace_name_city_unique
        UNIQUE (workspace_owner_id, city_id, canonical_name)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_places_workspace
      ON places(workspace_owner_id)
      WHERE archived_at IS NULL;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_places_workspace_city
      ON places(workspace_owner_id, city_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_places_verification_state
      ON places(workspace_owner_id, verification_state);
  `);
  logger.info("places table ready");

  // ai_invalid flag — set by the AI assessor when the place name is not a real address.
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS ai_invalid boolean;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS trusted_country_code text;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS trusted_country_source text;`);
  await db.query(`
    ALTER TABLE places DROP CONSTRAINT IF EXISTS places_trusted_country_source_check;
    ALTER TABLE places ADD CONSTRAINT places_trusted_country_source_check
      CHECK (trusted_country_source IS NULL OR trusted_country_source IN ('owner', 'delivery_city', 'order_ingest', 'linked_delivery'));
  `);
  await db.query(`
    UPDATE places p
       SET trusted_country_code = upper(dc.country_code),
           trusted_country_source = 'delivery_city'
      FROM delivery_cities dc
     WHERE p.city_id = dc.id
       AND p.trusted_country_code IS NULL
  `);
  // Automatic order linking may compact titles; a staff-authored title is
  // marked manual and is never rewritten by reconciliation.
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS canonical_name_source text NOT NULL DEFAULT 'manual';`);
  logger.info("places.ai_invalid column ready");

  // ── Place verification schema additions ────────────────────────────────────
  // coordinate_source enum — tracks where a place's coordinates came from.
  await db.query(`
    DO $$ BEGIN
      CREATE TYPE coordinate_source AS ENUM (
        'manual', 'gps', 'geocoder', 'import', 'ai', 'legacy'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS checkout_ready boolean NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS verified_at timestamptz;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS verified_by text;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS coordinate_source coordinate_source;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS verification_precision text;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS verification_method text;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS verification_source text;`);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE places ADD CONSTRAINT places_verification_precision_check
        CHECK (verification_precision IS NULL OR verification_precision IN ('exact', 'landmark', 'street', 'locality'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS location_conflict boolean NOT NULL DEFAULT false;`);
  logger.info("places verification schema columns ready");

  // Google Places integration columns — stored so the API key stays server-side and
  // fields do not need to be re-fetched from Google on every render.
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS google_place_id text;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS google_formatted_address text;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS google_place_type text;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS google_country text;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS google_city text;`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS google_original_lat numeric(10,7);`);
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS google_original_lng numeric(10,7);`);
  // Google Maps deep-link URL — stored so the UI can link directly without reconstructing it.
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS google_maps_url text;`);
  // Source order reference — the order whose driver GPS was used when source = linked_delivery.
  await db.query(`ALTER TABLE places ADD COLUMN IF NOT EXISTS source_order_id text;`);
  // Delivery-point (sub-entrance) support — a child place's parent is a canonical location.
  // Nesting is flat: a child cannot itself be a parent.
  await db.query(`
    ALTER TABLE places
      ADD COLUMN IF NOT EXISTS parent_place_id uuid REFERENCES places(id) ON DELETE SET NULL;
  `);
  // Partial unique index — one Google Place ID per workspace; NULLs are exempt so
  // manual places (no google_place_id) never collide.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_places_google_place_id
      ON places(workspace_owner_id, google_place_id)
      WHERE google_place_id IS NOT NULL;
  `);
  logger.info("places Google Places columns and parent_place_id ready");

  // place_aliases — alternative names for a place (e.g. landmarks, colloquial names).
  await db.query(`
    CREATE TABLE IF NOT EXISTS place_aliases (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      place_id          uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      alias_text        text NOT NULL,
      normalized_alias  text NOT NULL,
      language          text,
       source            text NOT NULL DEFAULT 'manual',
       approval_state    text NOT NULL DEFAULT 'approved',
      deleted_at        timestamptz,
      created_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT place_aliases_place_normalized_unique
        UNIQUE (place_id, normalized_alias)
    );
  `);
  await db.query(`ALTER TABLE place_aliases ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';`);
  await db.query(`ALTER TABLE place_aliases ADD COLUMN IF NOT EXISTS approval_state text NOT NULL DEFAULT 'approved';`);
  // Quarantine aliases that predate provenance. Earlier order ingestion used
  // raw delivery text as aliases, so a legacy "manual" default cannot prove
  // staff approval. This one-time marker lets new owner-created aliases retain
  // their explicit manual provenance on future startups.
  await db.query(`
    CREATE TABLE IF NOT EXISTS address_book_schema_migrations (
      key text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const aliasProvenanceMigration = await db.query<{ key: string }>(
    `INSERT INTO address_book_schema_migrations (key)
     VALUES ('place_alias_provenance_v1')
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
  );
  if (aliasProvenanceMigration.rows[0]) {
    await db.query(`
      UPDATE place_aliases
         SET source = 'legacy_untrusted',
             approval_state = 'unapproved'
       WHERE source = 'manual'
         AND approval_state = 'approved'
    `);
  }
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_place_aliases_place
      ON place_aliases(place_id)
      WHERE deleted_at IS NULL;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_place_aliases_normalized
      ON place_aliases(normalized_alias)
      WHERE deleted_at IS NULL;
  `);
  logger.info("place_aliases table ready");

  // Alias approval actor/time tracking columns.
  await db.query(`ALTER TABLE place_aliases ADD COLUMN IF NOT EXISTS approved_by text;`);
  await db.query(`ALTER TABLE place_aliases ADD COLUMN IF NOT EXISTS approved_at timestamptz;`);
  // Migrate any legacy 'unapproved' rows (set by the provenance migration) to
  // 'rejected' before the check constraint is applied. Runs exactly once.
  const approvalStateMigration = await db.query<{ key: string }>(
    `INSERT INTO address_book_schema_migrations (key)
     VALUES ('place_alias_approval_state_v1')
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
  );
  if (approvalStateMigration.rows[0]) {
    await db.query(`
      UPDATE place_aliases
         SET approval_state = 'rejected'
       WHERE approval_state = 'unapproved'
    `);
  }
  // Keep the legacy 'unapproved' value valid while older production rows are
  // being normalized. The one-time migration above converts it to 'rejected'
  // when the application initializes against that database. Including it here
  // is also required because Publish validates a new constraint against
  // production data before application startup runs.
  await db.query(`
    ALTER TABLE place_aliases
      DROP CONSTRAINT IF EXISTS place_aliases_approval_state_check;
  `);
  await db.query(`
    ALTER TABLE place_aliases
      ADD CONSTRAINT place_aliases_approval_state_check
      CHECK (approval_state IN ('approved', 'pending', 'rejected', 'unapproved'));
  `);
  logger.info("place_aliases approval columns and constraint ready");

  // Promote legacy Residence records whose canonical name or alias clearly
  // identifies guest houses/guesthouses/Airbnb locations. The Residence guard
  // is deliberate: explicitly selected non-residential types are untouched.
  const accommodationPromotion = await db.query(`
    UPDATE places p
       SET place_type = 'hotel', updated_at = now()
     WHERE lower(trim(p.place_type)) = 'residence'
       AND (
         regexp_replace(lower(p.canonical_name), '[^a-z0-9]+', ' ', 'g') ~ '(^| )guest ?houses?( |$)'
         OR regexp_replace(lower(p.canonical_name), '[^a-z0-9]+', ' ', 'g') ~ '(^| )air ?bnb( |$)'
         OR EXISTS (
           SELECT 1
             FROM place_aliases pa
            WHERE pa.place_id = p.id
              AND pa.deleted_at IS NULL
              AND (
                regexp_replace(lower(pa.alias_text), '[^a-z0-9]+', ' ', 'g') ~ '(^| )guest ?houses?( |$)'
                OR regexp_replace(lower(pa.alias_text), '[^a-z0-9]+', ' ', 'g') ~ '(^| )air ?bnb( |$)'
              )
         )
       )
  `);
  if (accommodationPromotion.rowCount && accommodationPromotion.rowCount > 0) {
    logger.info(
      { promoted: accommodationPromotion.rowCount },
      "address book: promoted legacy accommodation places to Hotel",
    );
  }

  // contact_addresses — per-contact saved addresses, optionally linked to a place.
  await db.query(`
    CREATE TABLE IF NOT EXISTS contact_addresses (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text NOT NULL,
      contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      place_id            uuid REFERENCES places(id) ON DELETE SET NULL,
      label               text,
      raw_address         text,
      area                text,
      city_id             integer REFERENCES delivery_cities(id) ON DELETE SET NULL,
      latitude            numeric(10, 7),
      longitude           numeric(10, 7),
      entrance_notes      text,
      is_default          boolean NOT NULL DEFAULT false,
      auto_linked         boolean NOT NULL DEFAULT false,
      archived_at         timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_contact_addresses_contact
      ON contact_addresses(contact_id)
      WHERE archived_at IS NULL;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_contact_addresses_place
      ON contact_addresses(place_id)
      WHERE place_id IS NOT NULL AND archived_at IS NULL;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_contact_addresses_workspace
      ON contact_addresses(workspace_owner_id);
  `);
  await db.query(`
    ALTER TABLE contact_addresses
      ADD COLUMN IF NOT EXISTS auto_linked boolean NOT NULL DEFAULT false;
  `);
  // Keep one active association per contact and Place while preserving every
  // existing record. If an older deployment already contains active
  // duplicates, archive all but the oldest row before adding the guard; this
  // keeps their saved details available for audit/history and excludes them
  // from Place-detail results.
  await db.query(`
    UPDATE contact_addresses duplicate
       SET archived_at = now(), updated_at = now()
     WHERE duplicate.archived_at IS NULL
       AND duplicate.place_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM contact_addresses keeper
          WHERE keeper.workspace_owner_id = duplicate.workspace_owner_id
            AND keeper.contact_id = duplicate.contact_id
            AND keeper.place_id = duplicate.place_id
            AND keeper.archived_at IS NULL
            AND (keeper.created_at, keeper.id) < (duplicate.created_at, duplicate.id)
       );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_addresses_active_contact_place
      ON contact_addresses(workspace_owner_id, contact_id, place_id)
      WHERE archived_at IS NULL AND place_id IS NOT NULL;
  `);
  logger.info("contact_addresses table ready");

  // Provenance for automatic order delivery-contact associations. This lets a
  // later recipient correction retire only an auto-created sender/customer
  // address when no other delivery supports it, without touching staff-saved
  // contact addresses.
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_place_contact_links (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text NOT NULL,
      order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      place_id            uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE(order_id, contact_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_place_contact_links_place_contact
      ON order_place_contact_links(workspace_owner_id, place_id, contact_id);
  `);
  logger.info("order_place_contact_links table ready");

  // order_place_links — links a placed order to a canonical place without
  // mutating the immutable orders.delivery_address snapshot.
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_place_links (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text NOT NULL,
      order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      place_id            uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      linked_by_user_id   text,
      linked_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT order_place_links_order_unique UNIQUE (order_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_place_links_place
      ON order_place_links(place_id);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_order_place_links_workspace
      ON order_place_links(workspace_owner_id);
  `);
  logger.info("order_place_links table ready");
  await db.query(`
    WITH linked_country AS (
      SELECT opl.place_id,
             min(CASE
               WHEN upper(trim(country_value)) IN ('LEBANON', 'LBN') THEN 'LB'
               WHEN upper(trim(country_value)) IN ('UNITED ARAB EMIRATES', 'UAE') THEN 'AE'
               ELSE upper(trim(country_value))
             END) AS country_code
        FROM order_place_links opl
        JOIN orders o ON o.id::text = opl.order_id::text
        CROSS JOIN LATERAL (
          VALUES (COALESCE(
            o.delivery_address->>'country_code',
            o.delivery_address->>'country',
            o.delivery_address->>'countryName'
          ))
        ) evidence(country_value)
       WHERE country_value IS NOT NULL AND trim(country_value) <> ''
       GROUP BY opl.place_id
      HAVING COUNT(DISTINCT CASE
        WHEN upper(trim(country_value)) IN ('LEBANON', 'LBN') THEN 'LB'
        WHEN upper(trim(country_value)) IN ('UNITED ARAB EMIRATES', 'UAE') THEN 'AE'
        ELSE upper(trim(country_value))
      END) = 1
    )
    UPDATE places p
       SET trusted_country_code = lc.country_code,
           trusted_country_source = 'linked_delivery'
      FROM linked_country lc
     WHERE p.id = lc.place_id
       AND p.city_id IS NULL
       AND p.trusted_country_code IS NULL
  `);

  // Private, order-scoped address context supports deterministic matching and
  // audit after the shared place title has been compacted. It is never exposed
  // as a place alias or public canonical field.
  await db.query(`
    CREATE TABLE IF NOT EXISTS place_order_address_contexts (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text NOT NULL,
      order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      place_id            uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      raw_address         text NOT NULL,
      normalized_address  text NOT NULL,
      city_id             integer REFERENCES delivery_cities(id) ON DELETE SET NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT place_order_address_contexts_order_unique UNIQUE (order_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_place_order_address_contexts_match
      ON place_order_address_contexts(workspace_owner_id, normalized_address, city_id);
  `);
  logger.info("place_order_address_contexts table ready");

  // place_verification_events — append-only audit log of all verification state
  // changes and merge operations for a place.
  await db.query(`
    CREATE TABLE IF NOT EXISTS place_verification_events (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      place_id      uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      event_type    text NOT NULL,
      from_state    place_verification_state,
      to_state      place_verification_state,
      actor_user_id text,
      actor_name    text,
      source        text,
      notes         text,
      metadata      jsonb,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_place_verification_events_place
      ON place_verification_events(place_id, created_at DESC);
  `);
  logger.info("place_verification_events table ready");

  // Durable, workspace-scoped queue for owner-triggered AI reverification.
  await db.query(`
    CREATE TABLE IF NOT EXISTS address_reverification_runs (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text NOT NULL,
      requested_by        text,
      status              text NOT NULL DEFAULT 'PENDING',
      provider_health     jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at          timestamptz NOT NULL DEFAULT now(),
      started_at          timestamptz,
      completed_at        timestamptz,
      snapshot_place_count integer NOT NULL DEFAULT 0,
      snapshot_eligible_count integer NOT NULL DEFAULT 0,
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT address_reverification_runs_status_check
        CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED_PROVIDER_OUTAGE', 'COMPLETED'))
    );
  `);
  await db.query(`ALTER TABLE address_reverification_runs ADD COLUMN IF NOT EXISTS provider_health jsonb NOT NULL DEFAULT '{}'::jsonb;`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_address_reverification_one_active_run
      ON address_reverification_runs(workspace_owner_id)
      WHERE status IN ('PENDING', 'RUNNING', 'PAUSED_PROVIDER_OUTAGE');
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_address_reverification_runs_workspace
      ON address_reverification_runs(workspace_owner_id, created_at DESC);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS address_reverification_jobs (
      id                  bigserial PRIMARY KEY,
      run_id              uuid NOT NULL REFERENCES address_reverification_runs(id) ON DELETE CASCADE,
      workspace_owner_id  text NOT NULL,
      place_id            uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      status              text NOT NULL DEFAULT 'PENDING',
      attempts            integer NOT NULL DEFAULT 0,
      next_retry_at       timestamptz,
      assessment_status   text,
      matched_location    text,
      result_precision    text,
      verification_method text,
      coordinates_changed boolean NOT NULL DEFAULT false,
      movement_km         numeric(12, 3),
      last_error          text,
      started_at          timestamptz,
      completed_at        timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT address_reverification_jobs_run_place_unique UNIQUE (run_id, place_id),
      CONSTRAINT address_reverification_jobs_status_check
        CHECK (status IN ('PENDING', 'RUNNING', 'RETRY_WAITING', 'SUCCEEDED', 'INVALID', 'UNRESOLVED', 'FAILED', 'SKIPPED'))
    );
  `);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS result_precision text;`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS verification_method text;`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS coordinates_changed boolean NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS movement_km numeric(12, 3);`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS assessment_cache jsonb;`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS assessment_cached_at timestamptz;`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS failure_provider text;`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS failure_type text;`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS failure_http_status integer;`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS failure_retry_after text;`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS failure_stage text;`);
  await db.query(`ALTER TABLE address_reverification_jobs ADD COLUMN IF NOT EXISTS failure_query text;`);
  await db.query(`ALTER TABLE address_reverification_runs ADD COLUMN IF NOT EXISTS paused_reason text;`);
  await db.query(`ALTER TABLE address_reverification_runs ADD COLUMN IF NOT EXISTS paused_until timestamptz;`);
  await db.query(`ALTER TABLE address_reverification_runs ADD COLUMN IF NOT EXISTS outage_provider text;`);
  await db.query(`ALTER TABLE address_reverification_runs ADD COLUMN IF NOT EXISTS outage_failure_type text;`);
  await db.query(`ALTER TABLE address_reverification_runs ADD COLUMN IF NOT EXISTS snapshot_place_count integer NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE address_reverification_runs ADD COLUMN IF NOT EXISTS snapshot_eligible_count integer NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE address_reverification_runs DROP CONSTRAINT IF EXISTS address_reverification_runs_status_check;`);
  await db.query(`ALTER TABLE address_reverification_runs ADD CONSTRAINT address_reverification_runs_status_check CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED_PROVIDER_OUTAGE', 'COMPLETED'));`);
  await db.query(`DROP INDEX IF EXISTS idx_address_reverification_one_active_run;`);
  await db.query(`CREATE UNIQUE INDEX idx_address_reverification_one_active_run ON address_reverification_runs(workspace_owner_id) WHERE status IN ('PENDING', 'RUNNING', 'PAUSED_PROVIDER_OUTAGE');`);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_address_reverification_jobs_claim
      ON address_reverification_jobs(status, next_retry_at, created_at);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_address_reverification_jobs_run
      ON address_reverification_jobs(run_id, status);
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_address_reverification_one_active_place
      ON address_reverification_jobs(place_id)
      WHERE status IN ('PENDING', 'RUNNING', 'RETRY_WAITING');
  `);
  logger.info("address reverification queue tables ready");

  // Previous AI geocodes were stored as "estimated". Only rows with explicit
  // AI map-pin audit evidence are promoted; non-AI estimated rows are retained.
  await db.query(`
    WITH upgraded AS (
      UPDATE places p
         SET verification_state = 'ai_verified',
             updated_at = now()
       WHERE p.verification_state = 'estimated'
         AND EXISTS (
           SELECT 1
             FROM place_verification_events pve
            WHERE pve.place_id = p.id
              AND pve.source = 'ai'
              AND pve.event_type = 'map_pin_updated'
         )
      RETURNING p.id
    )
    INSERT INTO place_verification_events
      (place_id, event_type, from_state, to_state, source, notes)
    SELECT id, 'state_change', 'estimated', 'ai_verified', 'startup_reconciliation',
           'Promoted a historical validated AI map match from Estimated to AI Verified.'
      FROM upgraded;
  `);

  // AUH is a known, reusable hospital identity. Promote only automatic
  // Residence defaults; staff-selected non-default types and all coordinates
  // remain untouched. The historical reconciliation performs the companion
  // title compaction when it has order-scoped address context.
  const auhPromotion = await db.query<{ id: string }>(`
    UPDATE places p
       SET place_type = 'hospital', updated_at = now()
     WHERE p.canonical_name_source = 'auto'
       AND lower(trim(p.place_type)) = 'residence'
       AND (
         regexp_replace(lower(p.canonical_name), '[^a-z0-9]+', ' ', 'g')
           ~ '(^| )american university( of beirut)? hospital( |$)'
         OR (
           regexp_replace(lower(p.canonical_name), '[^a-z0-9]+', ' ', 'g') ~ '(^| )auh( |$)'
           AND regexp_replace(lower(p.canonical_name), '[^a-z0-9]+', ' ', 'g')
             ~ '(^| )(hospital|medical|clinic|ward|patient|room|floor|unit|emergency|reception)( |$)'
         )
         OR EXISTS (
           SELECT 1
             FROM place_aliases pa
            WHERE pa.place_id = p.id
              AND pa.deleted_at IS NULL
              AND (
                regexp_replace(lower(pa.alias_text), '[^a-z0-9]+', ' ', 'g')
                  ~ '(^| )american university( of beirut)? hospital( |$)'
                OR (
                  regexp_replace(lower(pa.alias_text), '[^a-z0-9]+', ' ', 'g') ~ '(^| )auh( |$)'
                  AND regexp_replace(lower(pa.alias_text), '[^a-z0-9]+', ' ', 'g')
                    ~ '(^| )(hospital|medical|clinic|ward|patient|room|floor|unit|emergency|reception)( |$)'
                )
              )
         )
       )
     RETURNING p.id
  `);
  for (const place of auhPromotion.rows) {
    await db.query(
      `INSERT INTO place_verification_events
         (place_id, event_type, source, notes)
       VALUES ($1, 'place_type_corrected', 'startup_reconciliation', $2)`,
      [
        place.id,
        "Promoted an automatic Residence to Hospital after deterministic AUH recognition; existing links, aliases, and coordinates were preserved.",
      ],
    );
  }
  if (auhPromotion.rows.length) {
    logger.info(
      { promoted: auhPromotion.rows.length },
      "address book: promoted automatic AUH places to Hospital",
    );
  }

  // Identify legacy system-created titles so the Address Book reconciliation
  // can compact them without ever rewriting a manual title. New rows set this
  // source directly; this migration only classifies records with an explicit
  // auto-create event.
  await db.query(`
    UPDATE places p
       SET canonical_name_source = 'auto'
     WHERE p.canonical_name_source = 'manual'
       AND EXISTS (
         SELECT 1
           FROM place_verification_events pve
          WHERE pve.place_id = p.id
            AND pve.event_type = 'created'
            AND pve.source IN ('order_ingest_auto', 'historical_import')
       )
  `);
  // ── End Address Book ──────────────────────────────────────────────────────────

  // ── workspace_settings — cash session overdue grace period ────────────────
  await db.query(`
    ALTER TABLE workspace_settings
    ADD COLUMN IF NOT EXISTS cash_session_overdue_grace_minutes integer NOT NULL DEFAULT 120
  `);
  logger.info("workspace_settings.cash_session_overdue_grace_minutes column ready");

  // ── cash_sessions — transfer totals columns ───────────────────────────────
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS transfers_in_total  numeric(14,2) NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS transfers_out_total numeric(14,2) NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS transfers_in_total_secondary  numeric(14,2)`);
  await db.query(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS transfers_out_total_secondary numeric(14,2)`);
  logger.info("cash_sessions transfer totals columns ready");

  // ── cash_transfers — inter-drawer/inter-location cash transfer records ────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_transfers (
      id                        serial PRIMARY KEY,
      workspace_owner_id        text        NOT NULL,
      transfer_number           text        NOT NULL,
      source_location_id        integer     REFERENCES locations(id)     ON DELETE SET NULL,
      source_drawer_id          integer     NOT NULL REFERENCES cash_drawers(id) ON DELETE RESTRICT,
      source_session_id         integer     REFERENCES cash_sessions(id) ON DELETE SET NULL,
      destination_location_id   integer     REFERENCES locations(id)     ON DELETE SET NULL,
      destination_drawer_id     integer     NOT NULL REFERENCES cash_drawers(id) ON DELETE RESTRICT,
      destination_session_id    integer     REFERENCES cash_sessions(id) ON DELETE SET NULL,
      currency_code             text        NOT NULL,
      sent_amount               numeric(14,2) NOT NULL,
      received_amount           numeric(14,2),
      difference_amount         numeric(14,2),
      actual_received_amount    numeric(14,2),
      transfer_method           text        NOT NULL DEFAULT 'internal',
      status                    text        NOT NULL DEFAULT 'IN_TRANSIT',
      initiated_by_user_id      text,
      handed_over_by_user_id    text,
      intended_receiver_user_id text,
      received_by_user_id       text,
      carrier_user_id           text,
      carrier_type              text,
      external_carrier_name     text,
      note                      text,
      version                   integer     NOT NULL DEFAULT 1,
      resolution_reason         text,
      resolution_note           text,
      resolved_by_user_id       text,
      resolved_at               timestamptz,
      dispute_explanation       text,
      disputed_at               timestamptz,
      idempotency_key           text,
      handed_over_at            timestamptz,
      received_at               timestamptz,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cash_transfers_status_check
        CHECK (status IN ('IN_TRANSIT', 'COMPLETED', 'DISPUTED', 'CANCELLED')),
      CONSTRAINT cash_transfers_workspace_number_unique
        UNIQUE (workspace_owner_id, transfer_number)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfers_workspace     ON cash_transfers(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfers_status        ON cash_transfers(workspace_owner_id, status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfers_handed_over   ON cash_transfers(workspace_owner_id, handed_over_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfers_source_drawer ON cash_transfers(source_drawer_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfers_dest_drawer   ON cash_transfers(destination_drawer_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfers_source_sess   ON cash_transfers(source_session_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfers_dest_sess     ON cash_transfers(destination_session_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfers_currency      ON cash_transfers(workspace_owner_id, currency_code);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfers_receiver      ON cash_transfers(intended_receiver_user_id) WHERE intended_receiver_user_id IS NOT NULL;`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_transfers_idempotency ON cash_transfers(workspace_owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`);
  logger.info("cash_transfers table ready");

  // ── cash_transfer_audit_events — immutable audit log per transfer ─────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_transfer_audit_events (
      id                  serial      PRIMARY KEY,
      workspace_owner_id  text        NOT NULL,
      cash_transfer_id    integer     NOT NULL REFERENCES cash_transfers(id) ON DELETE CASCADE,
      event_type          text        NOT NULL,
      actor_user_id       text,
      actor_name          text,
      payload             jsonb,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfer_audit_transfer ON cash_transfer_audit_events(cash_transfer_id, created_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_transfer_audit_workspace ON cash_transfer_audit_events(workspace_owner_id);`);
  logger.info("cash_transfer_audit_events table ready");

  // ── cmc_return_counters — daily sequence for return references ────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_return_counters (
      workspace_owner_id  text    NOT NULL,
      date_key            text    NOT NULL,
      seq                 integer NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_owner_id, date_key)
    );
  `);
  logger.info("cmc_return_counters table ready");

  // ── cmc_returns — CMC branch-return headers ───────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_returns (
      id                    serial      PRIMARY KEY,
      workspace_owner_id    text        NOT NULL,
      branch_location_id    integer     REFERENCES locations(id) ON DELETE SET NULL,
      return_to_location_id integer     REFERENCES locations(id) ON DELETE SET NULL,
      operator_user_id      text,
      reference             text        NOT NULL,
      status                text        NOT NULL DEFAULT 'draft',
      collection_method     text,
      collection_date       text,
      notes                 text,
      tookan_job_id         text,
      tookan_task_id        text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cmc_returns_status_check
        CHECK (status IN ('draft', 'awaiting_pickup', 'cancelled', 'completed')),
      CONSTRAINT cmc_returns_workspace_reference_unique
        UNIQUE (workspace_owner_id, reference)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_returns_workspace  ON cmc_returns(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_returns_status     ON cmc_returns(workspace_owner_id, status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_returns_branch     ON cmc_returns(branch_location_id);`);
  logger.info("cmc_returns table ready");

  // ── cmc_return_line_items — per-SKU lines for each return ─────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_return_line_items (
      id              serial      PRIMARY KEY,
      return_id       integer     NOT NULL REFERENCES cmc_returns(id) ON DELETE CASCADE,
      product_id      integer     REFERENCES products(id) ON DELETE SET NULL,
      sku_snapshot    text,
      name_snapshot   text        NOT NULL,
      image_url       text,
      quantity        integer     NOT NULL,
      reason          text,
      stock_snapshot  integer,
      is_custom       boolean     NOT NULL DEFAULT false,
      adjustment_id   integer,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_return_line_items_return ON cmc_return_line_items(return_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_rli_return ON cmc_return_line_items(return_id);`);
  logger.info("cmc_return_line_items table ready");

  // ── cmc_return_events — immutable audit trail per return ──────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cmc_return_events (
      id              serial      PRIMARY KEY,
      return_id       integer     NOT NULL REFERENCES cmc_returns(id) ON DELETE CASCADE,
      actor_user_id   text,
      from_status     text,
      to_status       text        NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_return_events_return ON cmc_return_events(return_id, created_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cmc_rev_return ON cmc_return_events(return_id, created_at);`);
  logger.info("cmc_return_events table ready");

  // ── Events ──────────────────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS events (
      id                             serial PRIMARY KEY,
      workspace_owner_id             text NOT NULL,
      name                           text NOT NULL,
      description                    text,
      starting_price_usd             numeric(10,2) NOT NULL DEFAULT 0,
      starting_price_aed             numeric(10,2) NOT NULL DEFAULT 0,
      status                         text NOT NULL DEFAULT 'available',
      main_image_url                 text,
      additional_image_urls          text[] NOT NULL DEFAULT '{}',
      image_public_path              text,
      additional_image_public_paths  text[] NOT NULL DEFAULT '{}',
      is_archived                    boolean NOT NULL DEFAULT false,
      created_at                     timestamptz NOT NULL DEFAULT now(),
      updated_at                     timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_events_workspace ON events(workspace_owner_id);`);
  logger.info("events table ready");

  // event_occasions — junction table linking events to workspace occasions
  await db.query(`
    CREATE TABLE IF NOT EXISTS event_occasions (
      event_id     integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      attribute_id integer NOT NULL REFERENCES occasions(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, attribute_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_event_occasions_attr ON event_occasions(attribute_id);`);
  logger.info("event_occasions table ready");

  // event_publications — mirrors product_publications; one row per (event, channel) pair
  await db.query(`
    CREATE TABLE IF NOT EXISTS event_publications (
      id                   serial PRIMARY KEY,
      workspace_owner_id   text NOT NULL,
      event_id             integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      channel_id           integer NOT NULL REFERENCES publishing_channels(id) ON DELETE CASCADE,
      publication_status   text NOT NULL DEFAULT 'draft',
      is_visible           boolean NOT NULL DEFAULT true,
      published_at         timestamptz,
      unpublished_at       timestamptz,
      scheduled_publish_at timestamptz,
      scheduled_unpublish_at timestamptz,
      last_synced_at       timestamptz,
      sync_status          text NOT NULL DEFAULT 'never_synced',
      sync_error           text,
      public_slug          text,
      public_title         text,
      short_description    text,
      long_description     text,
      seo_title            text,
      seo_description      text,
      og_image_url         text,
      featured             boolean NOT NULL DEFAULT false,
      sort_order           integer,
      badges               jsonb NOT NULL DEFAULT '[]'::jsonb,
      extra_fields         jsonb NOT NULL DEFAULT '{}'::jsonb,
      price_override       numeric(10,2),
      sale_price_override  numeric(10,2),
      currency_override    text,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE(event_id, channel_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_event_publications_event ON event_publications(event_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_event_publications_channel ON event_publications(channel_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_event_publications_workspace ON event_publications(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_event_publications_status ON event_publications(channel_id, publication_status, is_visible);`);
  logger.info("event_publications table ready");
  // ── End Events ────────────────────────────────────────────────────────────────

  // ── CMC product-level stock tracking: make base_item_id nullable ─────────────
  // CMC-only stock adjustment rows (seeded via product edit, deducted on shelf
  // sale, incremented on branch-request receive) have no associated base item.
  // Dropping NOT NULL allows base_item_id = NULL; the FK still applies to non-NULL
  // values so existing base-item rows are unaffected.
  await db.query(`ALTER TABLE base_item_stock_adjustments ALTER COLUMN base_item_id DROP NOT NULL`);
  logger.info("base_item_stock_adjustments.base_item_id now nullable (CMC product-level stock)");

  // ── supplier_invoice_payments — cash payments against supplier invoices ──────
  // Records each cash payment applied to a supplier invoice.  Nullable
  // cash_transaction_id allows non-cash payment entries in the future.
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_invoice_payments (
      id                    serial        PRIMARY KEY,
      workspace_owner_id    text          NOT NULL,
      supplier_invoice_id   integer       NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
      cash_transaction_id   integer       REFERENCES cash_transactions(id) ON DELETE SET NULL,
      amount                numeric(14,4) NOT NULL,
      currency              text          NOT NULL,
      exchange_rate         numeric(14,6),
      paid_at               timestamptz   NOT NULL DEFAULT now(),
      is_reversed           boolean       NOT NULL DEFAULT false,
      created_at            timestamptz   NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sip_invoice   ON supplier_invoice_payments(supplier_invoice_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sip_cash_tx   ON supplier_invoice_payments(cash_transaction_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sip_workspace ON supplier_invoice_payments(workspace_owner_id);`);
  logger.info("supplier_invoice_payments table ready");

  // ── supplier_invoices.outstanding_balance — snapshot updated on each payment ─
  // Stored snapshot so payable-bills search is a simple indexed WHERE without
  // a correlated SUM subquery on every row. Backfill sets it for existing rows.
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS outstanding_balance numeric(14,4)`);
  // One-time backfill: existing invoices with no payments get their full bill total.
  await db.query(`
    UPDATE supplier_invoices
       SET outstanding_balance = COALESCE(grand_total, amount)
     WHERE outstanding_balance IS NULL
  `);
  logger.info("supplier_invoices.outstanding_balance column ready");

  // ── generated_invoices — persisted history of ad-hoc invoice PDFs ───────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS generated_invoices (
      id                  serial        PRIMARY KEY,
      workspace_owner_id  text          NOT NULL,
      invoice_number      text          NOT NULL,
      created_at          timestamptz   NOT NULL DEFAULT now(),
      customer_name       text,
      customer_email      text,
      customer_address    text,
      item_description    text,
      amount              numeric(14,4),
      currency            text,
      created_by_user_id  text,
      created_by_name     text,
      pdf_object_key      text,
      CONSTRAINT generated_invoices_workspace_number_unique
        UNIQUE (workspace_owner_id, invoice_number)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generated_invoices_workspace
      ON generated_invoices(workspace_owner_id, created_at DESC)
  `);
  logger.info("generated_invoices table ready");

  // ── suppliers — vat_status 3-state + reason columns ─────────────────────────
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS vat_status text NOT NULL DEFAULT 'unknown'`);
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS vat_not_registered_reason text`);
  // Back-fill vat_status from the legacy vat_registered boolean so existing rows are consistent.
  await db.query(`
    UPDATE suppliers
       SET vat_status = CASE WHEN vat_registered = true THEN 'registered' ELSE 'unknown' END
     WHERE vat_status = 'unknown' AND vat_registered IS NOT NULL
  `);
  logger.info("suppliers vat_status / vat_not_registered_reason columns ready");

  // ── orders search indexes ─────────────────────────────────────────────────────
  // Functional B-tree index so LOWER(display_order_number) = LOWER($param) lookups
  // (used by resolveOrderIdParam) hit an index instead of scanning the full table.
  try {
    {
      const existsBefore = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename  = 'orders'
              AND indexname  = 'idx_orders_lower_display_number'
         ) AS exists`,
      );
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_orders_lower_display_number
          ON orders (workspace_owner_id, lower(display_order_number));
      `);
      if (existsBefore.rows[0].exists) {
        logger.info("idx_orders_lower_display_number: already present in pg_indexes — no action needed");
      } else {
        logger.info("idx_orders_lower_display_number: was missing — created successfully (deployment migrated)");
      }
    }
    // GIN trigram index on display_order_number so ILIKE '%q%' search queries
    // use a bitmap index scan instead of a full table scan.
    // pg_trgm is already enabled earlier in this init sequence; re-assert here
    // in case this block runs before the products section on a future refactor.
    await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    {
      const existsBefore = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename  = 'orders'
              AND indexname  = 'idx_orders_display_number_trgm'
         ) AS exists`,
      );
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_orders_display_number_trgm
          ON orders USING GIN (display_order_number gin_trgm_ops)
          WHERE display_order_number IS NOT NULL;
      `);
      if (existsBefore.rows[0].exists) {
        logger.info("idx_orders_display_number_trgm: already present in pg_indexes — no action needed");
      } else {
        logger.info("idx_orders_display_number_trgm: was missing — created successfully (deployment migrated)");
      }
    }
    logger.info("orders search indexes ready");
  } catch (err) {
    logger.warn(
      { err },
      "orders search indexes skipped — pg_trgm may be unavailable; searches will use sequential scans",
    );
  }

  // Link a payment_link record to an order so staff can associate a
  // pre-existing payment link with a manually-created order. The relationship
  // lives on payment_links so one order can have many links. Keep the legacy
  // orders.payment_link_id column for old data/rollback safety, but no new
  // application path reads or writes it.
  await db.query(`
    ALTER TABLE payment_links
      ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS linked_at timestamptz,
      ADD COLUMN IF NOT EXISTS linked_by_user_id text;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_payment_links_order
      ON payment_links(order_id)
      WHERE order_id IS NOT NULL;
  `);
  // This legacy column predates the canonical relationship. Ensure it exists
  // before reading it so a fresh database can run this migration safely.
  await db.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS payment_link_id INTEGER REFERENCES payment_links(id);
  `);
  logger.info("orders.payment_link_id column ready");
  // Migrate only unambiguous legacy associations. A payment link is copied when
  // exactly one order in its workspace points at it and the old reference is
  // not shared by multiple orders. Ambiguous rows remain untouched.
  await db.query(`
    UPDATE payment_links pl
       SET order_id = legacy.order_id,
           linked_at = COALESCE(pl.linked_at, now())
      FROM (
        SELECT o.payment_link_id, MIN(o.id::text)::uuid AS order_id
          FROM orders o
          JOIN payment_links p
            ON p.id = o.payment_link_id
           AND p.workspace_owner_id = o.workspace_owner_id
         WHERE o.payment_link_id IS NOT NULL
         GROUP BY o.payment_link_id, o.workspace_owner_id
        HAVING COUNT(*) = 1
      ) legacy
     WHERE pl.id = legacy.payment_link_id
       AND pl.order_id IS NULL;
  `);

  // ── Google Review Rewards module ────────────────────────────────────────────
  // Employee QR profiles with trackable redirect codes, scan logging, ingested
  // Google reviews, review→scan attribution, and the reward lifecycle.
  await db.query(`
    CREATE TABLE IF NOT EXISTS employee_review_profiles (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      employee_name      text NOT NULL,
      role               text,
      reward_amount      numeric(10,2) NOT NULL DEFAULT 0,
      code               text NOT NULL,
      is_active          boolean NOT NULL DEFAULT true,
      archived_at        timestamptz,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `ALTER TABLE employee_review_profiles ADD COLUMN IF NOT EXISTS archived_at timestamptz;`,
  );
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_code ON employee_review_profiles(code);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_erp_workspace ON employee_review_profiles(workspace_owner_id);`);
  logger.info("employee_review_profiles table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS review_scans (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      profile_id         integer NOT NULL REFERENCES employee_review_profiles(id) ON DELETE CASCADE,
      scanned_at         timestamptz NOT NULL DEFAULT now(),
      device_hash        text,
      source             text,
      flagged            boolean NOT NULL DEFAULT false,
      match_status       text NOT NULL DEFAULT 'unmatched',
      matched_review_id  integer,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_review_scans_workspace_time ON review_scans(workspace_owner_id, scanned_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_review_scans_device ON review_scans(device_hash, scanned_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_review_scans_profile ON review_scans(profile_id, scanned_at);`);
  logger.info("review_scans table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS google_reviews (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      google_review_id   text NOT NULL,
      reviewer_name      text,
      rating             integer,
      comment            text,
      review_created_at  timestamptz NOT NULL,
      is_deleted         boolean NOT NULL DEFAULT false,
      deleted_at         timestamptz,
      match_status       text NOT NULL DEFAULT 'pending',
      matched_scan_id    integer,
      matched_profile_id integer,
      match_reason       text,
      match_resolved_by  text,
      match_resolved_at  timestamptz,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_google_reviews_workspace_review ON google_reviews(workspace_owner_id, google_review_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_google_reviews_workspace_status ON google_reviews(workspace_owner_id, match_status);`);
  logger.info("google_reviews table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS review_rewards (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      review_id          integer NOT NULL REFERENCES google_reviews(id) ON DELETE CASCADE,
      profile_id         integer NOT NULL REFERENCES employee_review_profiles(id) ON DELETE CASCADE,
      amount             numeric(10,2) NOT NULL,
      status             text NOT NULL DEFAULT 'pending',
      pending_until      timestamptz NOT NULL,
      approved_at        timestamptz,
      paid_at            timestamptz,
      paid_by            text,
      voided_at          timestamptz,
      void_reason        text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_review_rewards_review ON review_rewards(review_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_review_rewards_workspace_status ON review_rewards(workspace_owner_id, status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_review_rewards_profile ON review_rewards(profile_id);`);
  logger.info("review_rewards table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS review_match_audit (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      review_id          integer,
      reward_id          integer,
      action             text NOT NULL,
      actor_user_id      text,
      details            jsonb,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_review_match_audit_review ON review_match_audit(review_id, created_at);`);
  logger.info("review_match_audit table ready");

  // Per-workspace Google review URL used by the public scan redirect.
  await db.query(`ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS google_review_url text;`);
  logger.info("workspace_settings.google_review_url column ready");

  // ── Audiences — marketing segmentation layer above Contacts ─────────────
  //
  // Consent & suppression columns on contacts. Reachability is never inferred
  // from mere possession of an email/phone: email-reachable requires email +
  // email_consent + no global suppression; WhatsApp-reachable requires phone +
  // whatsapp_consent + no global suppression. Existing contacts default to
  // NOT consented — no automatic backfill rule applies (a messaging-provider
  // link, e.g. a respond.io contact, is not proof of consent).
  // unsubscribed_at is the global suppression timestamp.
  await db.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_consent boolean NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_consent boolean NOT NULL DEFAULT false;`);
  await db.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz;`);
  await db.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_updated_at timestamptz;`);
  logger.info("contacts consent/suppression columns ready");

  // Audiences container table. kind: 'dynamic' | 'static'; status: 'draft' |
  // 'active' | 'archived'. Dynamic audiences store their current rule tree in
  // `rules` (jsonb) with a schema version; cached evaluation metrics and
  // status live on the row so the index page never has to re-evaluate.
  await db.query(`
    CREATE TABLE IF NOT EXISTS audiences (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id text NOT NULL,
      name text NOT NULL,
      description text,
      kind text NOT NULL DEFAULT 'dynamic',
      status text NOT NULL DEFAULT 'draft',
      rules jsonb,
      rules_schema_version integer NOT NULL DEFAULT 1,
      rules_version integer NOT NULL DEFAULT 0,
      cached_counts jsonb,
      last_evaluated_at timestamptz,
      evaluation_status text NOT NULL DEFAULT 'idle',
      evaluation_error text,
      created_by text,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audiences_workspace ON audiences(workspace_owner_id, status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audiences_workspace_updated ON audiences(workspace_owner_id, updated_at);`);
  logger.info("audiences table ready");

  // Append-only rule-tree history for dynamic audiences.
  await db.query(`
    CREATE TABLE IF NOT EXISTS audience_rule_versions (
      id bigserial PRIMARY KEY,
      audience_id uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
      version integer NOT NULL,
      rules jsonb NOT NULL,
      rules_schema_version integer NOT NULL DEFAULT 1,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS audience_rule_versions_unique ON audience_rule_versions(audience_id, version);`);
  logger.info("audience_rule_versions table ready");

  // One-time idempotent migration: rewrite saved audience rules that still
  // reference the legacy ManyChat sync field to the respond.io field. The
  // evaluator also aliases the old key, so this is belt-and-braces.
  const audienceRuleFieldMigration = await db.query(`
    UPDATE audiences
       SET rules = replace(rules::text, '"manychat_synced"', '"respondio_synced"')::jsonb
     WHERE rules::text LIKE '%"manychat_synced"%'
  `);
  const audienceRuleVersionFieldMigration = await db.query(`
    UPDATE audience_rule_versions
       SET rules = replace(rules::text, '"manychat_synced"', '"respondio_synced"')::jsonb
     WHERE rules::text LIKE '%"manychat_synced"%'
  `);
  const migratedRuleRows =
    (audienceRuleFieldMigration.rowCount ?? 0) + (audienceRuleVersionFieldMigration.rowCount ?? 0);
  if (migratedRuleRows > 0) {
    logger.info(
      { migrated: migratedRuleRows },
      "audience rules migration: manychat_synced → respondio_synced",
    );
  }

  // Explicit membership for static audiences — only ever written by user
  // action (manual add / snapshot), never by the evaluator or refresh job.
  await db.query(`
    CREATE TABLE IF NOT EXISTS audience_members (
      id bigserial PRIMARY KEY,
      audience_id uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
      contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      source text NOT NULL DEFAULT 'manual',
      added_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS audience_members_unique ON audience_members(audience_id, contact_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audience_members_contact ON audience_members(contact_id);`);
  logger.info("audience_members table ready");

  // Segmentation-support indexes on common audience filter fields.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_contacts_workspace_created ON contacts(workspace_owner_id, created_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_contacts_workspace_source ON contacts(workspace_owner_id, source);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_order_contacts_contact_role ON order_contacts(contact_id, role);`);
  logger.info("audience segmentation indexes ready");

  // Google Business Profile connections — Review Rewards review ingestion.
  await db.query(`
    CREATE TABLE IF NOT EXISTS gbp_connections (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      credentials_encrypted text NOT NULL,
      account_name          text,
      account_label         text,
      location_name         text,
      location_title        text,
      notifications_state   text,
      last_error            text,
      last_synced_at        timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_gbp_connections_workspace ON gbp_connections(workspace_owner_id);`);
  // A GBP location may be connected by at most ONE workspace — otherwise the
  // webhook's location lookup would nondeterministically route reviews.
  await db.query(`DROP INDEX IF EXISTS idx_gbp_connections_location;`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_gbp_connections_location ON gbp_connections(location_name) WHERE location_name IS NOT NULL;`);
  // Drop the legacy global unique index on gbp_connections.location_name — it
  // prevents workspace B from setting its parent display field to a location that
  // workspace A previously selected but has since deselected.  Ownership is now
  // enforced exclusively by uq_gbp_location_connections_active on
  // gbp_location_connections; the parent location_name is display-only.
  await db.query(`DROP INDEX IF EXISTS uq_gbp_connections_location;`);
  logger.info("gbp_connections table ready");

  // Workspace-specific Google Business Profile OAuth clients. The encrypted
  // override is additive: existing shared-env connections stay intact until an
  // owner explicitly changes credentials from Review Rewards.
  await db.query(`
    CREATE TABLE IF NOT EXISTS gbp_oauth_config (
      id                    serial      PRIMARY KEY,
      workspace_owner_id    text        NOT NULL,
      oauth_client_encrypted text       NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gbp_oauth_config_unique
      ON gbp_oauth_config(workspace_owner_id);
  `);
  logger.info("gbp_oauth_config table ready");

  // Short-lived OAuth state tokens for the GBP connect flow (CSRF binding).
  await db.query(`
    CREATE TABLE IF NOT EXISTS gbp_oauth_states (
      state              text PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      expires_at         timestamptz NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  logger.info("gbp_oauth_states table ready");

  // ── gbp_location_connections — per-location tracking for multi-location GBP ─
  // One row per GBP location enabled by a workspace. The parent gbp_connections
  // row holds the OAuth credentials; this table tracks per-location state
  // (sync timestamps, error text, enabled/disabled toggle).
  await db.query(`
    CREATE TABLE IF NOT EXISTS gbp_location_connections (
      id                  serial PRIMARY KEY,
      workspace_owner_id  text NOT NULL,
      gbp_connection_id   integer NOT NULL REFERENCES gbp_connections(id) ON DELETE CASCADE,
      location_name       text NOT NULL,
      location_title      text,
      is_enabled          boolean NOT NULL DEFAULT true,
      notifications_state text,
      review_sync_status  text,
      last_error          text,
      last_synced_at      timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_gbp_location_connections_workspace_location
      ON gbp_location_connections(workspace_owner_id, location_name);
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_gbp_location_connections_workspace ON gbp_location_connections(workspace_owner_id);`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_gbp_location_connections_conn ON gbp_location_connections(gbp_connection_id);`,
  );
  // Per-location review URL — lets multi-location workspaces redirect each QR
  // to the correct Google review page for that branch.
  await db.query(`
    ALTER TABLE gbp_location_connections
      ADD COLUMN IF NOT EXISTS review_url text;
  `);
  // Per-location GBP account name (e.g. "accounts/123456789") — necessary so
  // that reconciliation and review listings use the correct account path for
  // each location when a workspace connects locations from multiple GBP accounts.
  await db.query(`
    ALTER TABLE gbp_location_connections
      ADD COLUMN IF NOT EXISTS account_name text;
  `);
  // Backfill from the parent gbp_connections row for rows that don't have it.
  await db.query(`
    UPDATE gbp_location_connections glc
       SET account_name = gc.account_name
      FROM gbp_connections gc
     WHERE glc.gbp_connection_id = gc.id
       AND glc.account_name IS NULL
       AND gc.account_name IS NOT NULL;
  `);

  // Backfill FIRST — before the global partial unique index is created — so
  // that pre-existing legacy rows from gbp_connections can all be inserted into
  // the new table (even if two workspaces share the same location_name).
  // Using ON CONFLICT DO NOTHING (no target) skips conflicts on ANY unique
  // constraint so this is safe on both first-run and subsequent idempotent runs.
  await db.query(`
    INSERT INTO gbp_location_connections
      (workspace_owner_id, gbp_connection_id, location_name, location_title,
       notifications_state, last_error, last_synced_at)
    SELECT workspace_owner_id, id, location_name, location_title,
           notifications_state, last_error, last_synced_at
      FROM gbp_connections
     WHERE location_name IS NOT NULL
    ON CONFLICT DO NOTHING;
  `);
  logger.info("gbp_location_connections backfill from gbp_connections complete");

  // Global tenant-isolation guard: at most one workspace may have a given GBP
  // location enabled at any time.  Run AFTER the backfill so legacy cross-
  // workspace duplicates are deduped before the partial unique index is created.
  await db.query(`
    UPDATE gbp_location_connections
       SET is_enabled = false, updated_at = now()
     WHERE id IN (
       SELECT id
         FROM (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY location_name
                    ORDER BY created_at ASC
                  ) AS rn
             FROM gbp_location_connections
            WHERE is_enabled = true
         ) ranked
        WHERE rn > 1
     );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_gbp_location_connections_active
      ON gbp_location_connections(location_name)
      WHERE is_enabled = true;
  `);
  // Neighbourhood / city from the GBP storefrontAddress — used to disambiguate
  // branches that share the same location_title in the UI.
  await db.query(`
    ALTER TABLE gbp_location_connections
      ADD COLUMN IF NOT EXISTS location_locality TEXT;
  `);
  logger.info("gbp_location_connections table ready");

  // Add gbp_location_id FK to review-rewards tables (nullable; SET NULL on delete).
  await db.query(`
    ALTER TABLE employee_review_profiles
      ADD COLUMN IF NOT EXISTS gbp_location_id integer
        REFERENCES gbp_location_connections(id) ON DELETE SET NULL;
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_erp_gbp_location ON employee_review_profiles(gbp_location_id) WHERE gbp_location_id IS NOT NULL;`,
  );
  await db.query(`
    ALTER TABLE review_scans
      ADD COLUMN IF NOT EXISTS gbp_location_id integer
        REFERENCES gbp_location_connections(id) ON DELETE SET NULL;
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_review_scans_gbp_location ON review_scans(gbp_location_id) WHERE gbp_location_id IS NOT NULL;`,
  );
  await db.query(`
    ALTER TABLE google_reviews
      ADD COLUMN IF NOT EXISTS gbp_location_id integer
        REFERENCES gbp_location_connections(id) ON DELETE SET NULL;
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_google_reviews_gbp_location ON google_reviews(gbp_location_id) WHERE gbp_location_id IS NOT NULL;`,
  );
  await db.query(`
    ALTER TABLE review_rewards
      ADD COLUMN IF NOT EXISTS gbp_location_id integer
        REFERENCES gbp_location_connections(id) ON DELETE SET NULL;
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_review_rewards_gbp_location ON review_rewards(gbp_location_id) WHERE gbp_location_id IS NOT NULL;`,
  );
  logger.info("gbp_location_id FK columns on review-rewards tables ready");

  // Provenance: full GBP review resource name (accounts/{a}/locations/{l}/reviews/{r})
  // so reconciliation only checks reviews against the location that produced them.
  await db.query(`ALTER TABLE google_reviews ADD COLUMN IF NOT EXISTS gbp_review_name text;`);
  logger.info("google_reviews.gbp_review_name column ready");

  // Add gbp_location_id FK to the four Review Rewards data tables (idempotent;
  // the first three are already covered by the gbp_location_connections block
  // above — IF NOT EXISTS makes these safe no-ops on existing DBs).
  await db.query(`
    ALTER TABLE employee_review_profiles
      ADD COLUMN IF NOT EXISTS gbp_location_id integer
        REFERENCES gbp_location_connections(id) ON DELETE SET NULL;
  `);
  await db.query(`
    ALTER TABLE review_scans
      ADD COLUMN IF NOT EXISTS gbp_location_id integer
        REFERENCES gbp_location_connections(id) ON DELETE SET NULL;
  `);
  await db.query(`
    ALTER TABLE google_reviews
      ADD COLUMN IF NOT EXISTS gbp_location_id integer
        REFERENCES gbp_location_connections(id) ON DELETE SET NULL;
  `);
  await db.query(`
    ALTER TABLE review_rewards
      ADD COLUMN IF NOT EXISTS gbp_location_id integer
        REFERENCES gbp_location_connections(id) ON DELETE SET NULL;
  `);
  logger.info("gbp_location_id FK columns verified on review rewards tables");

  // Backfill: existing rows in workspaces with exactly one enabled location
  // can be unambiguously attributed to it via gbp_location_connections.
  // Workspaces with no location or multiple locations leave rows as NULL.
  await db.query(`
    WITH single_location AS (
      SELECT workspace_owner_id, MIN(id) AS location_id
        FROM gbp_location_connections
       WHERE is_enabled = true
       GROUP BY workspace_owner_id
      HAVING count(*) = 1
    )
    UPDATE employee_review_profiles erp
       SET gbp_location_id = sl.location_id
      FROM single_location sl
     WHERE erp.workspace_owner_id = sl.workspace_owner_id
       AND erp.gbp_location_id IS NULL;
  `);
  await db.query(`
    WITH single_location AS (
      SELECT workspace_owner_id, MIN(id) AS location_id
        FROM gbp_location_connections
       WHERE is_enabled = true
       GROUP BY workspace_owner_id
      HAVING count(*) = 1
    )
    UPDATE review_scans rs
       SET gbp_location_id = sl.location_id
      FROM single_location sl
     WHERE rs.workspace_owner_id = sl.workspace_owner_id
       AND rs.gbp_location_id IS NULL;
  `);
  await db.query(`
    WITH single_location AS (
      SELECT workspace_owner_id, MIN(id) AS location_id
        FROM gbp_location_connections
       WHERE is_enabled = true
       GROUP BY workspace_owner_id
      HAVING count(*) = 1
    )
    UPDATE google_reviews gr
       SET gbp_location_id = sl.location_id
      FROM single_location sl
     WHERE gr.workspace_owner_id = sl.workspace_owner_id
       AND gr.gbp_location_id IS NULL;
  `);
  await db.query(`
    WITH single_location AS (
      SELECT workspace_owner_id, MIN(id) AS location_id
        FROM gbp_location_connections
       WHERE is_enabled = true
       GROUP BY workspace_owner_id
      HAVING count(*) = 1
    )
    UPDATE review_rewards rr
       SET gbp_location_id = sl.location_id
      FROM single_location sl
     WHERE rr.workspace_owner_id = sl.workspace_owner_id
       AND rr.gbp_location_id IS NULL;
  `);
  logger.info("gbp_location_id backfill complete (single-location workspaces attributed)");

  // Three-decimal currency precision: KWD, BHD, OMR require three decimal
  // places. Widen order_payment monetary columns from numeric(10,2) to
  // numeric(14,4) so no fractional digit is silently truncated.
  // USING cast is safe because numeric→numeric(14,4) never loses information
  // when the stored value already fits.
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'order_payment'
          AND column_name = 'amount'
          AND numeric_precision = 10
          AND numeric_scale = 2
      ) THEN
        ALTER TABLE order_payment
          ALTER COLUMN amount TYPE numeric(14,4) USING amount::numeric(14,4),
          ALTER COLUMN amount_usd TYPE numeric(14,4) USING amount_usd::numeric(14,4);
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'order_payment'
          AND column_name = 'refunded_amount'
          AND numeric_precision = 10
          AND numeric_scale = 2
      ) THEN
        ALTER TABLE order_payment
          ALTER COLUMN refunded_amount TYPE numeric(14,4) USING refunded_amount::numeric(14,4),
          ALTER COLUMN refunded_amount_usd TYPE numeric(14,4) USING refunded_amount_usd::numeric(14,4);
      END IF;
    END
    $$;
  `);
  logger.info("order_payment monetary columns widened to numeric(14,4)");

  // ── Toters CSV imports — marketplace sales as a fourth revenue channel ────
  // Money convention: original Items Total stored verbatim (numeric(14,4));
  // calculated USD revenue = items_total × 1500 ÷ 89700 stored with full
  // precision (numeric(18,8)). Only displayed values are rounded; aggregates
  // sum the unrounded stored values and round once.
  await db.query(`
    CREATE TABLE IF NOT EXISTS toters_import_batches (
      id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text          NOT NULL,
      file_name           text,
      imported_by_user_id text          NOT NULL,
      total_rows          integer       NOT NULL DEFAULT 0,
      inserted_count      integer       NOT NULL DEFAULT 0,
      duplicate_count     integer       NOT NULL DEFAULT 0,
      rejected_count      integer       NOT NULL DEFAULT 0,
      excluded_count      integer       NOT NULL DEFAULT 0,
      revenue_added       numeric(18,8) NOT NULL DEFAULT 0,
      created_at          timestamptz   NOT NULL DEFAULT now(),
      updated_at          timestamptz   NOT NULL DEFAULT now()
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_toters_import_batches_workspace ON toters_import_batches(workspace_owner_id, created_at)`,
  );
  logger.info("toters_import_batches table ready");

  await db.query(`
    CREATE TABLE IF NOT EXISTS toters_orders (
      id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_owner_id  text          NOT NULL,
      source              text          NOT NULL DEFAULT 'toters',
      external_order_code text,
      dedup_fingerprint   text          NOT NULL,
      client_first_name   text,
      store               text,
      status              text          NOT NULL,
      order_time          timestamptz,
      delivery_time       timestamptz,
      arrived_time        timestamptz,
      approved_time       timestamptz,
      marked_ready_time   timestamptz,
      items_total         numeric(14,4) NOT NULL DEFAULT 0,
      calculated_revenue  numeric(18,8) NOT NULL DEFAULT 0,
      batch_id            uuid          REFERENCES toters_import_batches(id) ON DELETE SET NULL,
      imported_by_user_id text,
      created_at          timestamptz   NOT NULL DEFAULT now(),
      updated_at          timestamptz   NOT NULL DEFAULT now()
    )
  `);
  // DB-level dedup: the normalized Code is the primary order identity;
  // rows without a Code fall back to a content fingerprint. Both are unique
  // per (workspace, source) so concurrent imports cannot create duplicates.
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_toters_orders_code ON toters_orders(workspace_owner_id, source, external_order_code) WHERE external_order_code IS NOT NULL`,
  );
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_toters_orders_fingerprint ON toters_orders(workspace_owner_id, source, dedup_fingerprint)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_toters_orders_workspace_status ON toters_orders(workspace_owner_id, status, arrived_time)`,
  );
  await db.query(`CREATE INDEX IF NOT EXISTS idx_toters_orders_batch ON toters_orders(batch_id)`);
  logger.info("toters_orders table ready");

  // ── scanner_stations — scanner device registration ───────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS scanner_stations (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      name               text NOT NULL,
      entity_id          integer REFERENCES finance_entities(id) ON DELETE SET NULL,
      location           text,
      status             text NOT NULL DEFAULT 'active',
      last_seen_at       timestamptz,
      agent_version      text,
      queued_count       integer NOT NULL DEFAULT 0,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    ALTER TABLE scanner_stations
      ADD COLUMN IF NOT EXISTS queued_count integer NOT NULL DEFAULT 0
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_scanner_stations_workspace ON scanner_stations(workspace_owner_id);`);
  logger.info("scanner_stations table ready");

  // ── scanner_pairing_codes — short-lived single-use pairing codes ─────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS scanner_pairing_codes (
      id                 serial PRIMARY KEY,
      station_id         integer NOT NULL REFERENCES scanner_stations(id) ON DELETE CASCADE,
      workspace_owner_id text NOT NULL,
      code               text NOT NULL,
      expires_at         timestamptz NOT NULL,
      used_at            timestamptz,
      correlation_id     uuid NOT NULL DEFAULT gen_random_uuid(),
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    ALTER TABLE scanner_pairing_codes
      ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid()
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_scanner_pairing_codes_station ON scanner_pairing_codes(station_id);`);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'scanner_pairing_codes'
            AND indexname  = 'idx_scanner_pairing_codes_code'
       ) AS exists`,
    );
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_scanner_pairing_codes_code ON scanner_pairing_codes(code) WHERE used_at IS NULL;`);
    if (existsBefore.rows[0].exists) {
      logger.info("idx_scanner_pairing_codes_code: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_scanner_pairing_codes_code: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("scanner_pairing_codes table ready");

  // ── scanner_device_tokens — hashed bearer tokens for scanner devices ──────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS scanner_device_tokens (
      id                 serial PRIMARY KEY,
      station_id         integer NOT NULL REFERENCES scanner_stations(id) ON DELETE CASCADE,
      workspace_owner_id text NOT NULL,
      token_hash         text NOT NULL,
      device_info        jsonb NOT NULL DEFAULT '{}',
      pairing_correlation_id uuid,
      created_at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT scanner_device_tokens_hash_unique UNIQUE (token_hash)
    );
  `);
  await db.query(`
    ALTER TABLE scanner_device_tokens
      ADD COLUMN IF NOT EXISTS pairing_correlation_id uuid
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_scanner_device_tokens_station ON scanner_device_tokens(station_id);`);
  logger.info("scanner_device_tokens table ready");

  // ── ai_invoice_imports scanner columns ───────────────────────────────────────
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'`);
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS scanner_station_id integer REFERENCES scanner_stations(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS file_sha256 text`);
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS captured_at timestamptz`);
  await db.query(`ALTER TABLE ai_invoice_imports ADD COLUMN IF NOT EXISTS scanner_uploaded_at timestamptz`);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'ai_invoice_imports'
            AND indexname  = 'idx_ai_invoice_imports_sha256'
       ) AS exists`,
    );
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_invoice_imports_sha256 ON ai_invoice_imports(workspace_owner_id, file_sha256) WHERE file_sha256 IS NOT NULL`);
    if (existsBefore.rows[0].exists) {
      logger.info("idx_ai_invoice_imports_sha256: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_ai_invoice_imports_sha256: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("ai_invoice_imports scanner columns ready");

  // ── supplier_statements reconciliation extension columns ─────────────────────
  await db.query(`ALTER TABLE supplier_statements ADD COLUMN IF NOT EXISTS accounting_entity_month_id integer REFERENCES accounting_entity_months(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE supplier_statements ADD COLUMN IF NOT EXISTS extraction_status text NOT NULL DEFAULT 'pending'`);
  await db.query(`ALTER TABLE supplier_statements ADD COLUMN IF NOT EXISTS extracted_at timestamptz`);
  await db.query(`ALTER TABLE supplier_statements ADD COLUMN IF NOT EXISTS replaced_by uuid REFERENCES supplier_statements(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE supplier_statements ADD COLUMN IF NOT EXISTS replacement_reason text`);
  logger.info("supplier_statements reconciliation columns ready");

  // ── supplier_statement_entries — one row per line item extracted ─────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_statement_entries (
      id                      serial PRIMARY KEY,
      supplier_statement_id   uuid NOT NULL REFERENCES supplier_statements(id) ON DELETE CASCADE,
      workspace_owner_id      text NOT NULL,
      entry_type              text NOT NULL,
      reference_number        text,
      entry_date              date,
      amount                  numeric(14,4) NOT NULL,
      currency                text NOT NULL DEFAULT 'USD',
      vat_amount              numeric(14,4),
      description             text,
      raw_text                text,
      normalized_reference    text,
      created_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_statement_entries_statement ON supplier_statement_entries(supplier_statement_id);`);
  logger.info("supplier_statement_entries table ready");

  // ── supplier_reconciliation_sessions — one row per supplier + period ──────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_reconciliation_sessions (
      id                          serial PRIMARY KEY,
      supplier_id                 integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      accounting_entity_month_id  integer NOT NULL REFERENCES accounting_entity_months(id) ON DELETE CASCADE,
      workspace_owner_id          text NOT NULL,
      status                      text NOT NULL DEFAULT 'statement_needed',
      statement_balance           numeric(14,4),
      os_balance                  numeric(14,4),
      balance_difference          numeric(14,4),
      open_exceptions_count       integer NOT NULL DEFAULT 0,
      prepared_by                 text,
      prepared_at                 timestamptz,
      approved_by                 text,
      approved_at                 timestamptz,
      reopen_reason               text,
      last_reopened_at            timestamptz,
      last_reopened_by            text,
      notes                       text,
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_recon_sessions_supplier_period ON supplier_reconciliation_sessions(supplier_id, accounting_entity_month_id);`);
  logger.info("supplier_reconciliation_sessions table ready");

  // ── supplier_reconciliation_matches — links statement entries to OS records ───
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_reconciliation_matches (
      id                  serial PRIMARY KEY,
      session_id          integer NOT NULL REFERENCES supplier_reconciliation_sessions(id) ON DELETE CASCADE,
      statement_entry_id  integer REFERENCES supplier_statement_entries(id) ON DELETE SET NULL,
      os_record_type      text,
      os_record_id        integer,
      match_type          text NOT NULL DEFAULT 'unmatched',
      match_confidence    numeric(5,4),
      match_signals       jsonb NOT NULL DEFAULT '{}'::jsonb,
      resolved_by         text,
      resolved_at         timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_recon_matches_session ON supplier_reconciliation_matches(session_id);`);
  logger.info("supplier_reconciliation_matches table ready");

  // ── supplier_reconciliation_exceptions — one row per detected discrepancy ─────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_reconciliation_exceptions (
      id                      serial PRIMARY KEY,
      session_id              integer NOT NULL REFERENCES supplier_reconciliation_sessions(id) ON DELETE CASCADE,
      workspace_owner_id      text NOT NULL,
      match_id                integer REFERENCES supplier_reconciliation_matches(id) ON DELETE SET NULL,
      exception_type          text NOT NULL,
      status                  text NOT NULL DEFAULT 'open',
      statement_data          jsonb,
      os_data                 jsonb,
      resolution_action       text,
      resolution_note         text,
      resolved_by             text,
      resolved_at             timestamptz,
      linked_os_record_type   text,
      linked_os_record_id     integer,
      audit_trail             jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_recon_exceptions_session_status ON supplier_reconciliation_exceptions(session_id, status);`);
  logger.info("supplier_reconciliation_exceptions table ready");

  // ── supplier_reconciliation_audit — append-only action log ───────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_reconciliation_audit (
      id                  serial PRIMARY KEY,
      session_id          integer NOT NULL REFERENCES supplier_reconciliation_sessions(id) ON DELETE CASCADE,
      workspace_owner_id  text NOT NULL,
      actor               text NOT NULL,
      action              text NOT NULL,
      detail              jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_recon_audit_session ON supplier_reconciliation_audit(session_id);`);
  logger.info("supplier_reconciliation_audit table ready");

  // ── supplier_reconciliation_sessions extra columns ────────────────────────────
  await db.query(`ALTER TABLE supplier_reconciliation_sessions ADD COLUMN IF NOT EXISTS difference_accepted_reason text`);
  logger.info("supplier_reconciliation_sessions.difference_accepted_reason column ready");

  // ── workspace_settings separation-of-duties flag ──────────────────────────────
  await db.query(`ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS require_approval_separation boolean NOT NULL DEFAULT false`);
  logger.info("workspace_settings.require_approval_separation column ready");

  // ── supplier_invoices Odoo sync columns ───────────────────────────────────────
  // Backfill the provider-neutral AI-import fields from legacy Odoo identity
  // where available. This is deliberately additive and safe to repeat.
  await db.query(`
    UPDATE ai_invoice_imports
       SET provider_bill_id = COALESCE(provider_bill_id, odoo_bill_id),
           provider_bill_url = COALESCE(provider_bill_url, odoo_bill_url),
           provider_bill_status = COALESCE(provider_bill_status, status),
           provider_sync_status = CASE
             WHEN provider_sync_status = 'pending'
               THEN COALESCE(sync_status, 'pending')
             ELSE provider_sync_status
           END,
           provider_synced_at = COALESCE(
             provider_synced_at,
             CASE WHEN status = 'sent_to_odoo' THEN updated_at ELSE NULL END
           )
     WHERE odoo_bill_id IS NOT NULL
        OR odoo_bill_url IS NOT NULL
        OR status = 'sent_to_odoo';
  `);
  // Historical versions treated a no-destination hand-off as a successful
  // accounting sync. Re-open only automatically-routed Odoo/Lebanon invoices
  // that have no Odoo identity; explicit reviewer exclusions remain untouched.
  await db.query(`
    UPDATE ai_invoice_imports i
       SET sync_status='not_requested',
           provider_sync_status='pending',
           provider_bill_status=NULL,
           provider_sync_error=NULL,
           provider_synced_at=NULL,
           error_message=NULL,
           updated_at=now()
      FROM finance_entities e
     WHERE e.id=i.entity_id
       AND e.workspace_owner_id=i.workspace_owner_id
       AND i.review_status='approved'
       AND (
         i.accounting_destination = 'odoo'
         OR (
           i.accounting_destination IS NULL
           AND (
             upper(trim(coalesce(e.country,''))) IN ('LB','LEBANON','LEBANESE')
             OR lower(coalesce(e.legal_name,'') || ' ' || coalesce(e.display_name,'')) ~ '\\m(lebanon|lebanese)\\M'
             OR upper(trim(coalesce(i.billing_country,''))) IN ('LB','LEBANON','LEBANESE')
             OR e.accounting_system='odoo'
           )
         )
       )
       AND nullif(i.provider_bill_id,'') IS NULL
       AND nullif(i.provider_bill_url,'') IS NULL
       AND nullif(i.odoo_bill_id,'') IS NULL
       AND nullif(i.odoo_bill_url,'') IS NULL
       AND NOT (
         i.provider_sync_status='succeeded'
         AND nullif(i.provider_bill_id,'') IS NOT NULL
         AND i.provider_bill_id=i.odoo_bill_id
         AND i.provider_bill_status IS DISTINCT FROM 'failed'
         AND nullif(i.odoo_bill_id,'') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM ai_invoice_import_sync_attempts a
            WHERE a.import_id=i.id
              AND a.destination='odoo'
              AND a.status='succeeded'
              AND a.verified_at IS NOT NULL
              AND a.external_reference=i.odoo_bill_id
         )
       );
  `);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS reconciliation_session_id integer REFERENCES supplier_reconciliation_sessions(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS odoo_bill_id text`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS odoo_bill_url text`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS odoo_synced_at timestamptz`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS odoo_sync_status text DEFAULT 'pending'`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS odoo_sync_error text`);
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS odoo_sync_idempotency_key text`);
  // Provider-neutral bill identity/state is canonical for new connectors.
  // Keep the Odoo columns above intact for legacy reads and retries.
  await db.query(`
    ALTER TABLE supplier_invoices
      ADD COLUMN IF NOT EXISTS provider_bill_id text,
      ADD COLUMN IF NOT EXISTS provider_bill_status text,
      ADD COLUMN IF NOT EXISTS provider_bill_url text,
      ADD COLUMN IF NOT EXISTS provider_sync_status text NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS provider_synced_at timestamptz,
      ADD COLUMN IF NOT EXISTS provider_sync_error text,
      ADD COLUMN IF NOT EXISTS provider_sync_idempotency_key text;
    CREATE INDEX IF NOT EXISTS idx_supplier_invoices_provider_bill
      ON supplier_invoices(workspace_owner_id, provider_bill_id);
    CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoices_provider_sync_key_unique
      ON supplier_invoices(workspace_owner_id, provider_sync_idempotency_key)
      WHERE provider_sync_idempotency_key IS NOT NULL;
    UPDATE supplier_invoices
       SET provider_bill_id = COALESCE(provider_bill_id, odoo_bill_id),
           provider_bill_url = COALESCE(provider_bill_url, odoo_bill_url),
           provider_synced_at = COALESCE(provider_synced_at, odoo_synced_at),
           provider_sync_status = CASE
             WHEN provider_sync_status = 'pending'
               THEN COALESCE(odoo_sync_status, 'pending')
             ELSE provider_sync_status
           END,
           provider_sync_error = COALESCE(provider_sync_error, odoo_sync_error),
           provider_sync_idempotency_key = COALESCE(
             provider_sync_idempotency_key,
             odoo_sync_idempotency_key
           )
     WHERE odoo_bill_id IS NOT NULL
        OR odoo_bill_url IS NOT NULL
        OR odoo_synced_at IS NOT NULL
        OR odoo_sync_error IS NOT NULL
        OR odoo_sync_idempotency_key IS NOT NULL;
  `);
  {
    const existsBefore = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'supplier_invoices'
            AND indexname  = 'idx_supplier_invoices_odoo_idempotency'
       ) AS exists`,
    );
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoices_odoo_idempotency ON supplier_invoices(odoo_sync_idempotency_key) WHERE odoo_sync_idempotency_key IS NOT NULL`);
    if (existsBefore.rows[0].exists) {
      logger.info("idx_supplier_invoices_odoo_idempotency: already present in pg_indexes — no action needed");
    } else {
      logger.info("idx_supplier_invoices_odoo_idempotency: was missing — created successfully (deployment migrated)");
    }
  }
  logger.info("supplier_invoices Odoo sync columns ready");

  // ── AI-imported supplier invoice ledger identity + backfill ───────────────
  await db.query(`ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS ai_import_id integer REFERENCES ai_invoice_imports(id) ON DELETE CASCADE`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoices_ai_import_unique ON supplier_invoices(ai_import_id) WHERE ai_import_id IS NOT NULL`);
  await db.query(`
    INSERT INTO supplier_invoices (
      supplier_id, workspace_owner_id, amount, currency, status, invoice_number,
      issued_at, notes, due_date, vat_amount, subtotal, grand_total,
      payment_status, file_urls, line_items, ai_import_id,
      odoo_bill_id, odoo_bill_url, odoo_synced_at, odoo_sync_status, odoo_sync_error
    )
    SELECT
      i.supplier_id,
      i.workspace_owner_id,
      COALESCE(i.total_amount, i.subtotal, 0),
      COALESCE(NULLIF(i.currency, ''), 'AED'),
      CASE
        WHEN i.status = 'duplicate_detected' THEN 'cancelled'
        WHEN i.status IN ('uploaded', 'processing', 'needs_review', 'failed') THEN 'draft'
        ELSE 'issued'
      END,
      i.invoice_number,
      COALESCE(i.invoice_date::timestamptz, i.created_at),
      CASE
        WHEN i.manual_notes IS NOT NULL THEN i.manual_notes
        WHEN i.original_filename IS NOT NULL THEN 'Imported from ' || i.original_filename
        ELSE 'AI-imported invoice'
      END,
      i.due_date,
      i.tax_amount,
      i.subtotal,
      i.total_amount,
      'unpaid',
      CASE WHEN i.pdf_storage_path IS NULL THEN NULL ELSE jsonb_build_array(i.pdf_storage_path) END,
      COALESCE(i.line_items, '[]'::jsonb),
      i.id,
      i.odoo_bill_id,
      i.odoo_bill_url,
      CASE WHEN i.status = 'sent_to_odoo' THEN i.updated_at ELSE NULL END,
      CASE
        WHEN i.status = 'sent_to_odoo' THEN 'synced'
        WHEN i.status = 'failed' THEN 'failed'
        ELSE 'pending'
      END,
      CASE WHEN i.status = 'failed' THEN i.error_message ELSE NULL END
    FROM ai_invoice_imports i
    JOIN suppliers s
      ON s.id = i.supplier_id
     AND s.workspace_owner_id = i.workspace_owner_id
    WHERE i.supplier_id IS NOT NULL
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
      odoo_bill_id = EXCLUDED.odoo_bill_id,
      odoo_bill_url = EXCLUDED.odoo_bill_url,
      odoo_synced_at = EXCLUDED.odoo_synced_at,
      odoo_sync_status = EXCLUDED.odoo_sync_status,
      odoo_sync_error = EXCLUDED.odoo_sync_error
  `);
  logger.info("supplier invoice AI import links ready");

  // ── Cash Activity Module ──────────────────────────────────────────────────
  // Entity scoping for cash drawers: nullable entity_id links a drawer to a
  // finance_entity so cash transactions can be filtered by entity via their
  // cash_drawer_id without adding entity_id to the high-frequency transactions
  // table. Existing drawers keep entity_id NULL (workspace-level scope).
  await db.query(`
    ALTER TABLE cash_drawers
      ADD COLUMN IF NOT EXISTS entity_id integer REFERENCES finance_entities(id) ON DELETE SET NULL;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_cash_drawers_entity
      ON cash_drawers(entity_id) WHERE entity_id IS NOT NULL;
  `);
  logger.info("cash_drawers.entity_id column ready");

  // cash_match_groups — groups of matched cash-in + cash-out transactions
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_match_groups (
      id                 serial       PRIMARY KEY,
      workspace_owner_id text         NOT NULL,
      entity_id          integer      REFERENCES finance_entities(id) ON DELETE SET NULL,
      location_id        integer      REFERENCES locations(id) ON DELETE SET NULL,
      cash_drawer_id     integer      REFERENCES cash_drawers(id) ON DELETE SET NULL,
      currency           text         NOT NULL,
      accounting_month   text         NOT NULL,
      matched_by         text         NOT NULL,
      note               text,
      status             text         NOT NULL DEFAULT 'ACTIVE',
      created_at         timestamptz  NOT NULL DEFAULT now(),
      updated_at         timestamptz  NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_match_groups_workspace ON cash_match_groups(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_match_groups_month ON cash_match_groups(workspace_owner_id, accounting_month);`);
  logger.info("cash_match_groups table ready");

  // cash_match_group_transactions — bridge table; UNIQUE(transaction_id) is the
  // concurrency guard preventing one transaction from landing in two groups.
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_match_group_transactions (
      id              serial   PRIMARY KEY,
      match_group_id  integer  NOT NULL REFERENCES cash_match_groups(id) ON DELETE CASCADE,
      transaction_id  integer  NOT NULL REFERENCES cash_transactions(id) ON DELETE CASCADE,
      CONSTRAINT cash_match_group_transactions_txn_unique UNIQUE (transaction_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_match_group_txns_group ON cash_match_group_transactions(match_group_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_match_group_txns_txn ON cash_match_group_transactions(transaction_id);`);
  logger.info("cash_match_group_transactions table ready");

  // cash_activity_audit_log — immutable audit trail for every cash-activity
  // event: MATCH, UNMATCH, FINALIZE, REOPEN.
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_activity_audit_log (
      id                 serial       PRIMARY KEY,
      workspace_owner_id text         NOT NULL,
      action             text         NOT NULL,
      actor              text         NOT NULL,
      reason             text,
      payload            jsonb        NOT NULL DEFAULT '{}',
      match_group_id     integer      REFERENCES cash_match_groups(id) ON DELETE SET NULL,
      year_month         text,
      entity_id          integer      REFERENCES finance_entities(id) ON DELETE SET NULL,
      created_at         timestamptz  NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_activity_audit_workspace ON cash_activity_audit_log(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_activity_audit_group ON cash_activity_audit_log(match_group_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_activity_audit_month ON cash_activity_audit_log(workspace_owner_id, year_month);`);
  logger.info("cash_activity_audit_log table ready");

  // cash_activity_months — finalization state per workspace/entity/month.
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_activity_months (
      id                 serial       PRIMARY KEY,
      workspace_owner_id text         NOT NULL,
      entity_id          integer      REFERENCES finance_entities(id) ON DELETE SET NULL,
      year_month         text         NOT NULL,
      status             text         NOT NULL DEFAULT 'OPEN',
      finalized_by       text,
      finalized_at       timestamptz,
      reopen_reason      text,
      reopen_actor       text,
      reopen_at          timestamptz,
      created_at         timestamptz  NOT NULL DEFAULT now(),
      updated_at         timestamptz  NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_activity_months_workspace ON cash_activity_months(workspace_owner_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_activity_months_month ON cash_activity_months(workspace_owner_id, year_month);`);
  // Two partial unique indexes to handle nullable entity_id correctly:
  // one for entity-scoped months, one for workspace-level months.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_activity_months_entity
      ON cash_activity_months(workspace_owner_id, entity_id, year_month)
      WHERE entity_id IS NOT NULL;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_activity_months_no_entity
      ON cash_activity_months(workspace_owner_id, year_month)
      WHERE entity_id IS NULL;
  `);
  logger.info("cash_activity_months table ready");

  // ── locations — per-location grace period for overdue session detection ──────
  await db.query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS grace_period_minutes integer;`);
  logger.info("locations.grace_period_minutes column ready");

  // ── workspace_settings — update cash_session_overdue_grace_minutes default to 30 ─
  await db.query(`
    ALTER TABLE workspace_settings
      ALTER COLUMN cash_session_overdue_grace_minutes SET DEFAULT 30
  `);
  await db.query(`
    UPDATE workspace_settings
       SET cash_session_overdue_grace_minutes = 30
     WHERE cash_session_overdue_grace_minutes = 120
  `);
  logger.info("workspace_settings.cash_session_overdue_grace_minutes default updated to 30");

  // ── cash_session_reminders — one row per reminder sent for an overdue session ─
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_session_reminders (
      id                    serial      PRIMARY KEY,
      cash_session_id       integer     NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
      workspace_id          text        NOT NULL,
      reminder_type         text        NOT NULL,
      sent_at               timestamptz NOT NULL DEFAULT now(),
      recipient_user_ids    integer[]   NOT NULL DEFAULT '{}',
      notification_channels jsonb       NOT NULL DEFAULT '[]',
      CONSTRAINT cash_session_reminders_type_check
        CHECK (reminder_type IN ('closing_time', 'overdue', 'manager_escalation'))
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_csr_session  ON cash_session_reminders(cash_session_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_csr_workspace ON cash_session_reminders(workspace_id, sent_at DESC);`);
  // Unique index required for ON CONFLICT (cash_session_id, reminder_type) DO NOTHING idempotency.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_csr_session_type
      ON cash_session_reminders(cash_session_id, reminder_type);
  `);
  // Expand check constraint to include long_open (used by the 8-hour long-open poller stage).
  await db.query(`ALTER TABLE cash_session_reminders DROP CONSTRAINT IF EXISTS cash_session_reminders_type_check;`);
  await db.query(`
    ALTER TABLE cash_session_reminders
      ADD CONSTRAINT cash_session_reminders_type_check
        CHECK (reminder_type IN ('closing_time', 'overdue', 'manager_escalation', 'long_open'));
  `);
  logger.info("cash_session_reminders table ready");

  // ── cash_session_resolutions — audit record per resolved overdue session ──────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cash_session_resolutions (
      id                      serial        PRIMARY KEY,
      cash_session_id         integer       NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
      workspace_id            text          NOT NULL,
      session_owner_id        text,
      resolver_id             text,
      approver_id             text,
      opened_at               timestamptz,
      original_business_date  date,
      configured_closing_time text,
      grace_period_minutes    integer,
      overdue_at              timestamptz,
      resolved_at             timestamptz,
      expected_balance        numeric(14,2),
      counted_balance         numeric(14,2),
      difference              numeric(14,2),
      currency                text,
      reason                  text,
      note                    text,
      manager_override        boolean       NOT NULL DEFAULT false,
      approval_required       boolean       NOT NULL DEFAULT false,
      approval_status         text,
      approval_at             timestamptz,
      final_session_status    text,
      created_at              timestamptz   NOT NULL DEFAULT now(),
      CONSTRAINT cash_session_resolutions_reason_check
        CHECK (reason IS NULL OR reason IN (
          'forgot_to_close', 'employee_unavailable', 'technical_issue',
          'store_closed_unexpectedly', 'other'
        )),
      CONSTRAINT cash_session_resolutions_approval_status_check
        CHECK (approval_status IS NULL OR approval_status IN ('pending', 'approved', 'rejected'))
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_csres_session   ON cash_session_resolutions(cash_session_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_csres_workspace  ON cash_session_resolutions(workspace_id, resolved_at DESC);`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_csres_active_per_session ON cash_session_resolutions(cash_session_id) WHERE resolved_at IS NULL;`);
  logger.info("cash_session_resolutions table ready");

  // ── cash_session_resolutions — approver_note column ──────────────────────────
  await db.query(`ALTER TABLE cash_session_resolutions ADD COLUMN IF NOT EXISTS approver_note text;`);
  logger.info("cash_session_resolutions.approver_note column ready");

  // ── cmc_shifts — resolution_id FK for overdue-session resolution records ──────
  await db.query(`
    ALTER TABLE cmc_shifts
      ADD COLUMN IF NOT EXISTS resolution_id integer
        REFERENCES cash_session_resolutions(id) ON DELETE SET NULL;
  `);
  logger.info("cmc_shifts.resolution_id column ready");

  // ── whatsapp_delivered_notifications — delayed order-delivered WhatsApp queue ─
  await db.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_delivered_notifications (
      id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id            text        NOT NULL,
      workspace_owner_id  text        NOT NULL,
      order_number        text        NOT NULL,
      status              text        NOT NULL DEFAULT 'pending',
      send_at             timestamptz NOT NULL,
      next_attempt_at     timestamptz NOT NULL,
      attempt_count       integer     NOT NULL DEFAULT 0,
      last_error          text,
      last_attempt_at     timestamptz,
      updated_at          timestamptz NOT NULL DEFAULT now(),
      created_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT whatsapp_delivered_notifications_order_id_unique UNIQUE (order_id),
      CONSTRAINT whatsapp_delivered_notifications_status_check
        CHECK (status IN ('pending', 'processing', 'sent', 'failed'))
    );
  `);
  // Index for the sweep query: due pending/stuck-processing rows ordered by next_attempt_at.
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_wdn_due
      ON whatsapp_delivered_notifications(next_attempt_at ASC)
      WHERE status IN ('pending', 'processing');
  `);
  logger.info("whatsapp_delivered_notifications table ready");

  // ── Seed CMC POS location config (idempotent) ─────────────────────────────────
  await db.query(`
    UPDATE locations
       SET same_day_cutoff_time = '18:30',
           timezone             = 'Asia/Beirut',
           grace_period_minutes = 30
     WHERE LOWER(name) LIKE '%cmc beirut hospital%'
  `);
  logger.info("CMC POS location config seed applied");


  // ── lb_bank_accounts — Lebanese bank account configuration ───────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS lb_bank_accounts (
      id                    serial PRIMARY KEY,
      workspace_owner_id    text NOT NULL,
      bank_name             text NOT NULL,
      account_name          text NOT NULL,
      masked_account_number text,
      currency              text NOT NULL DEFAULT 'LBP',
      is_active             boolean NOT NULL DEFAULT true,
      is_required_for_close boolean NOT NULL DEFAULT false,
      odoo_journal_id       integer,
      odoo_journal_name     text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT lb_bank_accounts_workspace_bank_account_currency_unique
        UNIQUE (workspace_owner_id, bank_name, account_name, currency)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lb_bank_accounts_workspace ON lb_bank_accounts(workspace_owner_id);`);
  logger.info("lb_bank_accounts table ready");

  // ── lb_bank_statements — uploaded bank statement file metadata ───────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS lb_bank_statements (
      id                serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      account_id        integer NOT NULL REFERENCES lb_bank_accounts(id) ON DELETE CASCADE,
      original_filename text,
      storage_path      text,
      file_hash         text,
      period_start      text,
      period_end        text,
      status            text NOT NULL DEFAULT 'uploaded',
      uploaded_by       text NOT NULL,
      error_message     text,
      metadata          jsonb NOT NULL DEFAULT '{}',
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lb_bank_statements_account_hash
      ON lb_bank_statements(account_id, file_hash)
      WHERE file_hash IS NOT NULL;
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lb_bank_statements_workspace ON lb_bank_statements(workspace_owner_id, created_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lb_bank_statements_account ON lb_bank_statements(account_id);`);
  logger.info("lb_bank_statements table ready");

  // ── lb_bank_statement_lines — individual posted/pending rows per statement ───
  await db.query(`
    CREATE TABLE IF NOT EXISTS lb_bank_statement_lines (
      id                 serial PRIMARY KEY,
      statement_id       integer NOT NULL REFERENCES lb_bank_statements(id) ON DELETE CASCADE,
      workspace_owner_id text NOT NULL,
      line_date          text,
      value_date         text,
      description        text,
      reference          text,
      debit_amount       text,
      credit_amount      text,
      balance            text,
      currency           text NOT NULL DEFAULT 'LBP',
      line_type          text NOT NULL DEFAULT 'posted',
      fingerprint        text,
      is_matched         boolean NOT NULL DEFAULT false,
      metadata           jsonb NOT NULL DEFAULT '{}',
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lb_bank_statement_lines_fingerprint
      ON lb_bank_statement_lines(statement_id, fingerprint)
      WHERE fingerprint IS NOT NULL;
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lb_bank_statement_lines_statement ON lb_bank_statement_lines(statement_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lb_bank_statement_lines_workspace ON lb_bank_statement_lines(workspace_owner_id);`);
  logger.info("lb_bank_statement_lines table ready");

  // ── lb_bank_statement_odoo_syncs — per-line Odoo sync results ────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS lb_bank_statement_odoo_syncs (
      id                 serial PRIMARY KEY,
      line_id            integer NOT NULL REFERENCES lb_bank_statement_lines(id) ON DELETE CASCADE,
      workspace_owner_id text NOT NULL,
      status             text NOT NULL DEFAULT 'pending',
      odoo_record_id     text,
      odoo_record_url    text,
      error_message      text,
      synced_at          timestamptz,
      metadata           jsonb NOT NULL DEFAULT '{}',
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lb_bank_statement_odoo_syncs_line ON lb_bank_statement_odoo_syncs(line_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lb_bank_statement_odoo_syncs_workspace ON lb_bank_statement_odoo_syncs(workspace_owner_id);`);
  // One sync record per line — enforce uniqueness so ON CONFLICT upserts work correctly.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lb_bank_statement_odoo_syncs_line_unique ON lb_bank_statement_odoo_syncs(line_id);`);
  logger.info("lb_bank_statement_odoo_syncs table ready");

  // ── lb_bank_audit_log — immutable append-only configuration change log ────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS lb_bank_audit_log (
      id                 serial PRIMARY KEY,
      workspace_owner_id text NOT NULL,
      actor_id           text NOT NULL,
      account_id         integer,
      action             text NOT NULL,
      before             jsonb,
      after              jsonb,
      metadata           jsonb NOT NULL DEFAULT '{}',
      created_at         timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lb_bank_audit_log_workspace ON lb_bank_audit_log(workspace_owner_id, created_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lb_bank_audit_log_account ON lb_bank_audit_log(account_id) WHERE account_id IS NOT NULL;`);
  // Append-only enforcement: block UPDATE and DELETE on lb_bank_audit_log so
  // the log is truly immutable. The trigger is idempotent (CREATE OR REPLACE).
  await db.query(`
    CREATE OR REPLACE FUNCTION lb_bank_audit_log_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'lb_bank_audit_log is append-only and cannot be modified or deleted';
    END;
    $$;
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_lb_bank_audit_log_immutable ON lb_bank_audit_log;`);
  await db.query(`
    CREATE TRIGGER trg_lb_bank_audit_log_immutable
    BEFORE UPDATE OR DELETE ON lb_bank_audit_log
    FOR EACH ROW EXECUTE FUNCTION lb_bank_audit_log_immutable();
  `);
  logger.info("lb_bank_audit_log table ready (append-only trigger installed)");

  // ── lb_bank_statements: Odoo sync status + reconciliation status columns ─────
  await db.query(`ALTER TABLE lb_bank_statements ADD COLUMN IF NOT EXISTS odoo_sync_status text NOT NULL DEFAULT 'not_synced'`);
  await db.query(`ALTER TABLE lb_bank_statements ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'pending'`);
  await db.query(`ALTER TABLE lb_bank_statements ADD COLUMN IF NOT EXISTS reconciled_by text`);
  await db.query(`ALTER TABLE lb_bank_statements ADD COLUMN IF NOT EXISTS reconciled_at timestamptz`);
  logger.info("lb_bank_statements: odoo_sync_status, reconciliation_status columns ready");

  // ── lb_bank_statement_lines: exception classification columns ─────────────────
  await db.query(`ALTER TABLE lb_bank_statement_lines ADD COLUMN IF NOT EXISTS classification text`);
  await db.query(`ALTER TABLE lb_bank_statement_lines ADD COLUMN IF NOT EXISTS classification_reason text`);
  await db.query(`ALTER TABLE lb_bank_statement_lines ADD COLUMN IF NOT EXISTS classified_by text`);
  await db.query(`ALTER TABLE lb_bank_statement_lines ADD COLUMN IF NOT EXISTS classified_at timestamptz`);
  logger.info("lb_bank_statement_lines: classification columns ready");

  // ── Review Rewards: country on locations, team member link, currency ────────
  // Step 1: Add country to gbp_location_connections so the frontend can drive
  // currency labels (Lebanon → USD, UAE → AED) without a separate lookup.
  await db.query(`
    ALTER TABLE gbp_location_connections
      ADD COLUMN IF NOT EXISTS country text;
  `);
  // Best-effort backfill: derive country from location_title patterns for
  // existing rows that were saved before regionCode extraction was added.
  // UAE locations are matched first (more distinctive keywords); remaining
  // unclassified rows in known Lebanese cities are then marked Lebanon.
  // NULL stays for locations we cannot classify — the UI defaults to USD.
  await db.query(`
    UPDATE gbp_location_connections
       SET country = 'UAE'
     WHERE country IS NULL
       AND (
         LOWER(location_title) LIKE '%uae%'
         OR LOWER(location_title) LIKE '%dubai%'
         OR LOWER(location_title) LIKE '%abu dhabi%'
         OR LOWER(location_title) LIKE '%sharjah%'
         OR LOWER(location_title) LIKE '%ajman%'
         OR LOWER(location_title) LIKE '% ae%'
       );
  `);
  await db.query(`
    UPDATE gbp_location_connections
       SET country = 'Lebanon'
     WHERE country IS NULL
       AND (
         LOWER(location_title) LIKE '%lebanon%'
         OR LOWER(location_title) LIKE '%beirut%'
         OR LOWER(location_title) LIKE '%hamra%'
         OR LOWER(location_title) LIKE '%zalka%'
         OR LOWER(location_title) LIKE '%jdeideh%'
         OR LOWER(location_title) LIKE '%jounieh%'
         OR LOWER(location_title) LIKE '%dbayeh%'
         OR LOWER(location_title) LIKE '%antelias%'
         OR LOWER(location_title) LIKE '%baabda%'
         OR LOWER(location_title) LIKE '%metn%'
       );
  `);
  logger.info("gbp_location_connections.country column ready");

  // Step 2: Link employee review profiles to real team_member records.
  // Nullable for backward compat; SET NULL on delete so orphan QR codes remain.
  await db.query(`
    ALTER TABLE employee_review_profiles
      ADD COLUMN IF NOT EXISTS team_member_id integer
        REFERENCES team_members(id) ON DELETE SET NULL;
  `);

  // Step 3: Also allow profiles to link to a workspace login user when no HR
  // team_member record exists. Existing HR links remain nullable and intact.
  await db.query(`
    ALTER TABLE employee_review_profiles
      ADD COLUMN IF NOT EXISTS workspace_member_id integer
        REFERENCES workspace_members(id) ON DELETE SET NULL;
  `);

  // Step 4: Persist the currency that was active when the QR was created so
  // payouts use the correct currency even if the location's country changes.
  await db.query(`
    ALTER TABLE employee_review_profiles
      ADD COLUMN IF NOT EXISTS reward_currency text NOT NULL DEFAULT 'USD';
  `);

  // Step 5: Unique partial indexes — one active QR per employee per location.
  // Partial (team_member_id IS NOT NULL AND archived_at IS NULL) so the
  // constraint only fires for linked, live profiles, not legacy free-text rows.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_team_member_location
      ON employee_review_profiles(workspace_owner_id, gbp_location_id, team_member_id)
      WHERE team_member_id IS NOT NULL AND archived_at IS NULL;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_workspace_member_location
      ON employee_review_profiles(workspace_owner_id, gbp_location_id, workspace_member_id)
      WHERE workspace_member_id IS NOT NULL AND archived_at IS NULL;
  `);
  logger.info("employee_review_profiles employee references, reward currency, and unique indexes ready");

  await initLockClient.query("COMMIT");
  initLockTransactionStarted = false;
  // The bounded worker runs only after migration locks have been released.
  await backfillRealDeliveryPublications(db);
  await processRealDeliveryPublications(db, 10);
  initDbSucceeded = true;
  } catch (error) {
    initDbSucceeded = false;
    if (initLockTransactionStarted) {
      try {
        await initLockClient.query("ROLLBACK");
      } catch (rollbackError) {
        destroyInitLockClient = true;
        logger.error(
          { err: rollbackError },
          "database initialization advisory-lock transaction rollback failed; destroying pooled client",
        );
      }
    }
    throw error;
  } finally {
    initLockClient.release(destroyInitLockClient);
    logStartupTiming("database_initialization", "complete", initDbStartedAt, {
      status: initDbSucceeded ? "success" : "failed",
    });
  }
}
