/**
 * Integration tests for the people-directory linkage migration.
 *
 * The startup migration in initDb.ts links team_members → people →
 * team_member_profiles.  This suite runs the DO block directly against a real
 * PostgreSQL database to ensure:
 *
 *  1. A new people row is created for each unlinked team_member that has no
 *     existing people row for its email + workspace.
 *  2. An existing people row is reused (not duplicated) when a team_member's
 *     email matches an existing row in the same workspace.
 *  3. team_members without an email still get a people row and a profile.
 *  4. team_members that already have a linked team_member_profiles row are left
 *     untouched (idempotency).
 *  5. GET /people returns non-null person_id and profile_id for every
 *     linked team_member.
 *
 * Auth and workspace middleware are stubbed.  The database is real — rows are
 * seeded under a collision-safe OWNER_ID and cleaned up in afterAll.
 *
 * The suite skips automatically when DATABASE_URL is not set.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique owner so test rows never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_people_linkage__";
const USER_ID = "__integration_test_people_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — only auth / workspace / logger; db uses the real pool
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = USER_ID;
    wreq.userEmail = "people-test@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Import router AFTER vi.mock declarations (hoisting boundary)
import peopleRouter, { _resetTeamMembersTableExistsForTesting } from "./people";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(peopleRouter);
  return app;
}

/**
 * Run the migration DO block that links team_members → people → team_member_profiles.
 * This mirrors the logic in initDb.ts exactly, using the provided pool.
 */
async function runLinkageMigration(pool: InstanceType<typeof Pool>): Promise<void> {
  // Ensure the team_member_id column exists (idempotent, mirrors initDb.ts)
  await pool.query(`
    ALTER TABLE team_member_profiles
      ADD COLUMN IF NOT EXISTS team_member_id integer REFERENCES team_members(id) ON DELETE SET NULL;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tmp_team_member_id
      ON team_member_profiles (team_member_id)
      WHERE team_member_id IS NOT NULL;
  `);

  // DO block: for every unlinked team_member, create or reuse a people row
  // then create the team_member_profiles linkage row.
  await pool.query(`
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "people-directory linkage migration integration tests",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // IDs created during seeding — used for assertions and cleanup
    let tmWithNewEmailId: number;     // TM whose email has no pre-existing people row
    let tmWithExistingEmailId: number; // TM whose email already has a people row
    let tmNoEmailId: number;           // TM with no email
    let tmAlreadyLinkedId: number;     // TM that already has a team_member_profiles row

    let preExistingPersonId: number;  // people row seeded before migration

    // Whether we created tables in this test run (so afterAll knows to drop them)
    let createdTeamMembersTable = false;
    let createdDepartmentsTable = false;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // ── Ensure team_members table exists (Drizzle-managed; may not be present in
      //    dev/CI environments where `db push` has not been run yet) ──────────────
      const tmExistsResult = await pool.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name   = 'team_members'
        ) AS exists
      `);
      if (!tmExistsResult.rows[0]?.exists) {
        await pool.query(`
          CREATE TABLE team_members (
            id                       serial PRIMARY KEY,
            workspace_owner_id       text NOT NULL,
            first_name               text NOT NULL,
            last_name                text,
            email                    text,
            phone                    text,
            department_id            integer,
            employment_status        text NOT NULL DEFAULT 'full_time',
            start_date               date,
            emergency_contact_name   text,
            emergency_contact_phone  text,
            archived_at              timestamptz,
            created_at               timestamptz NOT NULL DEFAULT now(),
            updated_at               timestamptz NOT NULL DEFAULT now()
          )
        `);
        createdTeamMembersTable = true;
      }

      // ── Ensure departments table exists (Drizzle-managed; needed by the
      //    people route's LEFT JOIN on team_members) ──────────────────────────
      const deptExistsResult = await pool.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name   = 'departments'
        ) AS exists
      `);
      if (!deptExistsResult.rows[0]?.exists) {
        await pool.query(`
          CREATE TABLE departments (
            id                 serial PRIMARY KEY,
            workspace_owner_id text NOT NULL,
            name               text NOT NULL,
            status             text NOT NULL DEFAULT 'active',
            created_at         timestamptz NOT NULL DEFAULT now(),
            updated_at         timestamptz NOT NULL DEFAULT now()
          )
        `);
        createdDepartmentsTable = true;
      }

      // ── Ensure team_member_id column exists on team_member_profiles ───────
      // The initDb migration adds this column later (ALTER TABLE ... ADD COLUMN
      // IF NOT EXISTS). When team_members didn't exist before, the column may
      // be absent. We run the idempotent ALTER here so seeding the
      // "already linked" row succeeds.
      await pool.query(`
        ALTER TABLE team_member_profiles
          ADD COLUMN IF NOT EXISTS team_member_id integer REFERENCES team_members(id) ON DELETE SET NULL;
      `);

      // ── Clean up any leftovers from previous failed runs ──────────────────
      await pool.query(
        `DELETE FROM team_member_profiles WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM people WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM team_members WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      // ── Seed: pre-existing people row for alice (email match test) ─────────
      const personResult = await pool.query<{ id: number }>(
        `INSERT INTO people (workspace_owner_id, first_name, last_name, email, status)
         VALUES ($1, 'Alice', 'Pre', 'alice@example.com', 'active')
         RETURNING id`,
        [OWNER_ID],
      );
      preExistingPersonId = personResult.rows[0].id;

      // ── Seed: TM with new email (no matching people row) ──────────────────
      const tmNewResult = await pool.query<{ id: number }>(
        `INSERT INTO team_members
           (workspace_owner_id, first_name, last_name, email, employment_status)
         VALUES ($1, 'Bob', 'New', 'bob@example.com', 'full_time')
         RETURNING id`,
        [OWNER_ID],
      );
      tmWithNewEmailId = tmNewResult.rows[0].id;

      // ── Seed: TM whose email matches the pre-existing people row ──────────
      const tmExistingResult = await pool.query<{ id: number }>(
        `INSERT INTO team_members
           (workspace_owner_id, first_name, last_name, email, employment_status)
         VALUES ($1, 'Alice', 'TM', 'alice@example.com', 'full_time')
         RETURNING id`,
        [OWNER_ID],
      );
      tmWithExistingEmailId = tmExistingResult.rows[0].id;

      // ── Seed: TM with no email ─────────────────────────────────────────────
      const tmNoEmailResult = await pool.query<{ id: number }>(
        `INSERT INTO team_members
           (workspace_owner_id, first_name, last_name, employment_status)
         VALUES ($1, 'Charlie', 'Noemail', 'full_time')
         RETURNING id`,
        [OWNER_ID],
      );
      tmNoEmailId = tmNoEmailResult.rows[0].id;

      // ── Seed: TM that is already linked (migration must skip it) ──────────
      const tmAlreadyResult = await pool.query<{ id: number }>(
        `INSERT INTO team_members
           (workspace_owner_id, first_name, email, employment_status)
         VALUES ($1, 'Dana', 'dana@example.com', 'full_time')
         RETURNING id`,
        [OWNER_ID],
      );
      tmAlreadyLinkedId = tmAlreadyResult.rows[0].id;

      // Create the people + profile rows for tmAlreadyLinked manually
      const danaPersonResult = await pool.query<{ id: number }>(
        `INSERT INTO people (workspace_owner_id, first_name, email, status)
         VALUES ($1, 'Dana', 'dana@example.com', 'active')
         RETURNING id`,
        [OWNER_ID],
      );
      await pool.query(
        `INSERT INTO team_member_profiles
           (person_id, workspace_owner_id, team_member_id, employment_type, status)
         VALUES ($1, $2, $3, 'full_time', 'active')`,
        [danaPersonResult.rows[0].id, OWNER_ID, tmAlreadyLinkedId],
      );

      // ── Run the migration ─────────────────────────────────────────────────
      await runLinkageMigration(pool);
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM team_member_profiles WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM people WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      if (createdTeamMembersTable) {
        // Drop the table we created so we leave no permanent schema changes.
        // team_member_profiles.team_member_id references team_members, so drop
        // the column first to avoid FK constraint issues.
        await pool.query(`
          ALTER TABLE team_member_profiles DROP COLUMN IF EXISTS team_member_id
        `);
        await pool.query(`DROP TABLE IF EXISTS team_members`);
      } else {
        await pool.query(
          `DELETE FROM team_members WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
      }
      if (createdDepartmentsTable) {
        await pool.query(`DROP TABLE IF EXISTS departments`);
      }
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. people rows — correct count, no duplicates
    // ─────────────────────────────────────────────────────────────────────────

    describe("people rows after migration", () => {
      it("creates exactly one people row for the TM with a new email", async () => {
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM people
            WHERE workspace_owner_id = $1 AND LOWER(email) = 'bob@example.com'`,
          [OWNER_ID],
        );
        expect(parseInt(result.rows[0].count, 10)).toBe(1);
      });

      it("reuses the pre-existing people row for the email-matched TM (no duplicate)", async () => {
        const result = await pool.query<{ count: string; id: number }>(
          `SELECT COUNT(*) AS count, MIN(id) AS id FROM people
            WHERE workspace_owner_id = $1 AND LOWER(email) = 'alice@example.com'`,
          [OWNER_ID],
        );
        // Still exactly one alice people row
        expect(parseInt(result.rows[0].count, 10)).toBe(1);
        // The surviving row is the pre-seeded one
        expect(result.rows[0].id).toBe(preExistingPersonId);
      });

      it("creates a people row for the TM without an email", async () => {
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM people
            WHERE workspace_owner_id = $1 AND email IS NULL AND first_name = 'Charlie'`,
          [OWNER_ID],
        );
        expect(parseInt(result.rows[0].count, 10)).toBe(1);
      });

      it("total people count for the workspace equals 4 (no duplicates)", async () => {
        // bob + alice (pre-existing) + charlie + dana = 4
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM people WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        expect(parseInt(result.rows[0].count, 10)).toBe(4);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. team_member_profiles — every team_member has a linked profile
    // ─────────────────────────────────────────────────────────────────────────

    describe("team_member_profiles linkage after migration", () => {
      it("creates a profile row with team_member_id for the new-email TM", async () => {
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM team_member_profiles
            WHERE workspace_owner_id = $1 AND team_member_id = $2`,
          [OWNER_ID, tmWithNewEmailId],
        );
        expect(parseInt(result.rows[0].count, 10)).toBe(1);
      });

      it("creates a profile row pointing to the pre-existing people row for the email-matched TM", async () => {
        const result = await pool.query<{ person_id: number }>(
          `SELECT person_id FROM team_member_profiles
            WHERE workspace_owner_id = $1 AND team_member_id = $2`,
          [OWNER_ID, tmWithExistingEmailId],
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].person_id).toBe(preExistingPersonId);
      });

      it("creates a profile row with team_member_id for the no-email TM", async () => {
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM team_member_profiles
            WHERE workspace_owner_id = $1 AND team_member_id = $2`,
          [OWNER_ID, tmNoEmailId],
        );
        expect(parseInt(result.rows[0].count, 10)).toBe(1);
      });

      it("does not create a duplicate profile for the already-linked TM", async () => {
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM team_member_profiles
            WHERE workspace_owner_id = $1 AND team_member_id = $2`,
          [OWNER_ID, tmAlreadyLinkedId],
        );
        // Still exactly one profile row — migration did not add a second one
        expect(parseInt(result.rows[0].count, 10)).toBe(1);
      });

      it("all 4 team_members have exactly one profile row each", async () => {
        const ids = [
          tmWithNewEmailId,
          tmWithExistingEmailId,
          tmNoEmailId,
          tmAlreadyLinkedId,
        ];
        for (const tmId of ids) {
          const result = await pool.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM team_member_profiles
              WHERE workspace_owner_id = $1 AND team_member_id = $2`,
            [OWNER_ID, tmId],
          );
          expect(parseInt(result.rows[0].count, 10), `team_member_id=${tmId}`).toBe(1);
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. GET /people — person_id and profile_id are populated
    // ─────────────────────────────────────────────────────────────────────────

    describe("GET /people — person_id and profile_id in response", () => {
      it("returns person_id and profile_id for the new-email TM", async () => {
        const res = await request(app).get("/people");

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("people");

        const person = (res.body.people as Array<Record<string, unknown>>).find(
          (p) => p.team_member_id === tmWithNewEmailId,
        );

        expect(person).toBeDefined();
        expect(person!.person_id).not.toBeNull();
        expect(typeof person!.person_id).toBe("number");
        expect(person!.profile_id).not.toBeNull();
        expect(typeof person!.profile_id).toBe("number");
      });

      it("returns person_id equal to the pre-existing people row for the email-matched TM", async () => {
        const res = await request(app).get("/people");

        expect(res.status).toBe(200);

        const person = (res.body.people as Array<Record<string, unknown>>).find(
          (p) => p.team_member_id === tmWithExistingEmailId,
        );

        expect(person).toBeDefined();
        expect(person!.person_id).toBe(preExistingPersonId);
        expect(person!.profile_id).not.toBeNull();
      });

      it("returns person_id and profile_id for the no-email TM", async () => {
        const res = await request(app).get("/people");

        expect(res.status).toBe(200);

        const person = (res.body.people as Array<Record<string, unknown>>).find(
          (p) => p.team_member_id === tmNoEmailId,
        );

        expect(person).toBeDefined();
        expect(person!.person_id).not.toBeNull();
        expect(person!.profile_id).not.toBeNull();
      });

      it("returns person_id and profile_id for the already-linked TM", async () => {
        const res = await request(app).get("/people");

        expect(res.status).toBe(200);

        const person = (res.body.people as Array<Record<string, unknown>>).find(
          (p) => p.team_member_id === tmAlreadyLinkedId,
        );

        expect(person).toBeDefined();
        expect(person!.person_id).not.toBeNull();
        expect(person!.profile_id).not.toBeNull();
      });

      it("returns stats with correct team member counts", async () => {
        const res = await request(app).get("/people");

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("stats");
        const stats = res.body.stats as Record<string, number>;
        // All 4 TMs are active team_members in this workspace
        expect(stats.totalTeamMembers).toBeGreaterThanOrEqual(4);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Migration is idempotent — running it a second time is a no-op
    // ─────────────────────────────────────────────────────────────────────────

    describe("idempotency — re-running migration does not create extra rows", () => {
      it("people count stays the same after a second migration run", async () => {
        const before = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM people WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        const countBefore = parseInt(before.rows[0].count, 10);

        await runLinkageMigration(pool);

        const after = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM people WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        expect(parseInt(after.rows[0].count, 10)).toBe(countBefore);
      });

      it("team_member_profiles count stays the same after a second migration run", async () => {
        const before = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM team_member_profiles
            WHERE workspace_owner_id = $1 AND team_member_id IS NOT NULL`,
          [OWNER_ID],
        );
        const countBefore = parseInt(before.rows[0].count, 10);

        await runLinkageMigration(pool);

        const after = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM team_member_profiles
            WHERE workspace_owner_id = $1 AND team_member_id IS NOT NULL`,
          [OWNER_ID],
        );
        expect(parseInt(after.rows[0].count, 10)).toBe(countBefore);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. POST /people — creates a team_member row; person_id/profile_id are
    //    null until the linkage migration runs (documents the known gap)
    // ─────────────────────────────────────────────────────────────────────────

    describe("POST /people — team_member creation", () => {
      // Shared state set up once for this describe block
      let postResponse: Record<string, unknown>;
      let createdTmId: number;

      beforeAll(async () => {
        const res = await request(app).post("/people").send({
          first_name: "Eve",
          last_name: "PostTest",
          email: "eve-posttest@example.com",
          employment_status: "full_time",
        });
        postResponse = res.body as Record<string, unknown>;
        createdTmId = postResponse.team_member_id as number;
      });

      it("returns HTTP 201 with a team_member_id in the body", async () => {
        const res = await request(app).post("/people").send({
          first_name: "Grace",
          last_name: "StatusCheck",
          email: "grace-statuscheck@example.com",
          employment_status: "full_time",
        });
        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty("team_member_id");
        expect(typeof res.body.team_member_id).toBe("number");
      });

      it("response includes first_name, last_name and email from the request body", () => {
        expect(postResponse.first_name).toBe("Eve");
        expect(postResponse.last_name).toBe("PostTest");
        expect(postResponse.email).toBe("eve-posttest@example.com");
      });

      it("person_id is non-null immediately after creation (linked inline by POST /people)", () => {
        expect(postResponse.person_id).not.toBeNull();
        expect(typeof postResponse.person_id).toBe("number");
      });

      it("profile_id is non-null immediately after creation (linked inline by POST /people)", () => {
        expect(postResponse.profile_id).not.toBeNull();
        expect(typeof postResponse.profile_id).toBe("number");
      });

      it("team_member row is persisted in the database", async () => {
        const result = await pool.query<{ id: number; first_name: string; last_name: string }>(
          `SELECT id, first_name, last_name
             FROM team_members
            WHERE workspace_owner_id = $1 AND id = $2`,
          [OWNER_ID, createdTmId],
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].first_name).toBe("Eve");
        expect(result.rows[0].last_name).toBe("PostTest");
      });

      it("returns 400 when first_name is missing", async () => {
        const res = await request(app).post("/people").send({
          last_name: "NoFirstName",
          email: "nofirstname@example.com",
        });
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty("error");
      });

      it("after running the linkage migration the new team_member gets a non-null person_id and profile_id", async () => {
        await runLinkageMigration(pool);

        const res = await request(app).get("/people");
        expect(res.status).toBe(200);

        const person = (res.body.people as Array<Record<string, unknown>>).find(
          (p) => p.team_member_id === createdTmId,
        );

        expect(person).toBeDefined();
        expect(person!.person_id).not.toBeNull();
        expect(typeof person!.person_id).toBe("number");
        expect(person!.profile_id).not.toBeNull();
        expect(typeof person!.profile_id).toBe("number");
      });

      it("running the linkage migration again after linking is idempotent for the newly created team_member", async () => {
        const before = await pool.query<{ person_id: number; profile_id: number }>(
          `SELECT tmp.person_id, tmp.id AS profile_id
             FROM team_member_profiles tmp
            WHERE tmp.workspace_owner_id = $1 AND tmp.team_member_id = $2`,
          [OWNER_ID, createdTmId],
        );
        expect(before.rows).toHaveLength(1);
        const { person_id: personIdBefore, profile_id: profileIdBefore } = before.rows[0];

        await runLinkageMigration(pool);

        const after = await pool.query<{ person_id: number; profile_id: number }>(
          `SELECT tmp.person_id, tmp.id AS profile_id
             FROM team_member_profiles tmp
            WHERE tmp.workspace_owner_id = $1 AND tmp.team_member_id = $2`,
          [OWNER_ID, createdTmId],
        );
        expect(after.rows).toHaveLength(1);
        expect(after.rows[0].person_id).toBe(personIdBefore);
        expect(after.rows[0].profile_id).toBe(profileIdBefore);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. PATCH /people/:id — email change syncs people and team_member_profiles
    // ─────────────────────────────────────────────────────────────────────────

    describe("PATCH /people/:id — email change keeps people in sync", () => {
      // Create two fresh team_members (with profiles) for this suite so we
      // don't interfere with the migration-suite rows above.
      let patchTmId: number;          // TM whose email we will update
      let patchTmIdRelink: number;    // TM whose email we will change to match an existing people row
      let patchOrigPersonId: number;  // people row linked to patchTmId before any change
      let relinkTargetPersonId: number; // pre-existing people row that patchTmIdRelink will be re-linked to

      beforeAll(async () => {
        // ── TM 1: basic email update ────────────────────────────────────────
        const tm1Result = await pool.query<{ id: number }>(
          `INSERT INTO team_members
             (workspace_owner_id, first_name, last_name, email, employment_status)
           VALUES ($1, 'Frank', 'Patch', 'frank-patch@example.com', 'full_time')
           RETURNING id`,
          [OWNER_ID],
        );
        patchTmId = tm1Result.rows[0].id;

        const person1Result = await pool.query<{ id: number }>(
          `INSERT INTO people (workspace_owner_id, first_name, last_name, email, status)
           VALUES ($1, 'Frank', 'Patch', 'frank-patch@example.com', 'active')
           RETURNING id`,
          [OWNER_ID],
        );
        patchOrigPersonId = person1Result.rows[0].id;

        await pool.query(
          `INSERT INTO team_member_profiles
             (person_id, workspace_owner_id, team_member_id, employment_type, status)
           VALUES ($1, $2, $3, 'full_time', 'active')`,
          [patchOrigPersonId, OWNER_ID, patchTmId],
        );

        // ── TM 2: re-link to an existing people row ─────────────────────────
        // Pre-seed a people row that already has the target email
        const relinkTargetResult = await pool.query<{ id: number }>(
          `INSERT INTO people (workspace_owner_id, first_name, last_name, email, status)
           VALUES ($1, 'Heidi', 'Existing', 'heidi-existing@example.com', 'active')
           RETURNING id`,
          [OWNER_ID],
        );
        relinkTargetPersonId = relinkTargetResult.rows[0].id;

        const tm2Result = await pool.query<{ id: number }>(
          `INSERT INTO team_members
             (workspace_owner_id, first_name, last_name, email, employment_status)
           VALUES ($1, 'Ivan', 'Relink', 'ivan-relink@example.com', 'full_time')
           RETURNING id`,
          [OWNER_ID],
        );
        patchTmIdRelink = tm2Result.rows[0].id;

        const ivan_person_res = await pool.query<{ id: number }>(
          `INSERT INTO people (workspace_owner_id, first_name, last_name, email, status)
           VALUES ($1, 'Ivan', 'Relink', 'ivan-relink@example.com', 'active')
           RETURNING id`,
          [OWNER_ID],
        );
        const ivanPersonId = ivan_person_res.rows[0].id;

        await pool.query(
          `INSERT INTO team_member_profiles
             (person_id, workspace_owner_id, team_member_id, employment_type, status)
           VALUES ($1, $2, $3, 'full_time', 'active')`,
          [ivanPersonId, OWNER_ID, patchTmIdRelink],
        );
      });

      it("PATCH updates the linked people row email when the new email is unique", async () => {
        const res = await request(app)
          .patch(`/people/tm_${patchTmId}`)
          .send({ email: "frank-new@example.com" });

        expect(res.status).toBe(200);

        // people row should now have the new email
        const pplResult = await pool.query<{ email: string }>(
          `SELECT email FROM people WHERE id = $1`,
          [patchOrigPersonId],
        );
        expect(pplResult.rows[0].email).toBe("frank-new@example.com");

        // profile still points to the same people row
        const profResult = await pool.query<{ person_id: number }>(
          `SELECT person_id FROM team_member_profiles
            WHERE team_member_id = $1 AND workspace_owner_id = $2`,
          [patchTmId, OWNER_ID],
        );
        expect(profResult.rows[0].person_id).toBe(patchOrigPersonId);
      });

      it("response from PATCH contains correct non-null person_id and profile_id", async () => {
        const res = await request(app)
          .patch(`/people/tm_${patchTmId}`)
          .send({ email: "frank-new2@example.com" });

        expect(res.status).toBe(200);
        expect(res.body.person_id).not.toBeNull();
        expect(typeof res.body.person_id).toBe("number");
        expect(res.body.profile_id).not.toBeNull();
        expect(typeof res.body.profile_id).toBe("number");
      });

      it("PATCH re-links team_member_profiles to the existing people row when email matches one", async () => {
        const res = await request(app)
          .patch(`/people/tm_${patchTmIdRelink}`)
          .send({ email: "heidi-existing@example.com" });

        expect(res.status).toBe(200);

        // The profile should now point to the pre-existing people row
        const profResult = await pool.query<{ person_id: number }>(
          `SELECT person_id FROM team_member_profiles
            WHERE team_member_id = $1 AND workspace_owner_id = $2`,
          [patchTmIdRelink, OWNER_ID],
        );
        expect(profResult.rows[0].person_id).toBe(relinkTargetPersonId);

        // Response person_id must equal the re-linked people row
        expect(res.body.person_id).toBe(relinkTargetPersonId);
      });

      it("does not create a duplicate people row when email is re-linked", async () => {
        const countResult = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM people
            WHERE workspace_owner_id = $1 AND LOWER(email) = 'heidi-existing@example.com'`,
          [OWNER_ID],
        );
        expect(parseInt(countResult.rows[0].count, 10)).toBe(1);
      });

      it("PATCH clearing the email to null updates the linked people row email to null", async () => {
        const res = await request(app)
          .patch(`/people/tm_${patchTmId}`)
          .send({ email: "" });

        expect(res.status).toBe(200);

        const pplResult = await pool.query<{ email: string | null }>(
          `SELECT email FROM people WHERE id = $1`,
          [patchOrigPersonId],
        );
        expect(pplResult.rows[0].email).toBeNull();
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. PATCH /people/:id — first_name, last_name, phone sync to people row
    // ─────────────────────────────────────────────────────────────────────────

    describe("PATCH /people/:id — name and phone changes keep people in sync", () => {
      let syncTmId: number;
      let syncPersonId: number;

      beforeAll(async () => {
        const tmResult = await pool.query<{ id: number }>(
          `INSERT INTO team_members
             (workspace_owner_id, first_name, last_name, phone, email, employment_status)
           VALUES ($1, 'Judy', 'Original', '+1000000001', 'judy-sync@example.com', 'full_time')
           RETURNING id`,
          [OWNER_ID],
        );
        syncTmId = tmResult.rows[0].id;

        const personResult = await pool.query<{ id: number }>(
          `INSERT INTO people
             (workspace_owner_id, first_name, last_name, phone, email, status)
           VALUES ($1, 'Judy', 'Original', '+1000000001', 'judy-sync@example.com', 'active')
           RETURNING id`,
          [OWNER_ID],
        );
        syncPersonId = personResult.rows[0].id;

        await pool.query(
          `INSERT INTO team_member_profiles
             (person_id, workspace_owner_id, team_member_id, employment_type, status)
           VALUES ($1, $2, $3, 'full_time', 'active')`,
          [syncPersonId, OWNER_ID, syncTmId],
        );
      });

      it("PATCH first_name syncs the linked people row first_name", async () => {
        const res = await request(app)
          .patch(`/people/tm_${syncTmId}`)
          .send({ first_name: "Judith" });

        expect(res.status).toBe(200);

        const pplResult = await pool.query<{ first_name: string }>(
          `SELECT first_name FROM people WHERE id = $1`,
          [syncPersonId],
        );
        expect(pplResult.rows[0].first_name).toBe("Judith");
      });

      it("PATCH last_name syncs the linked people row last_name", async () => {
        const res = await request(app)
          .patch(`/people/tm_${syncTmId}`)
          .send({ last_name: "Updated" });

        expect(res.status).toBe(200);

        const pplResult = await pool.query<{ last_name: string }>(
          `SELECT last_name FROM people WHERE id = $1`,
          [syncPersonId],
        );
        expect(pplResult.rows[0].last_name).toBe("Updated");
      });

      it("PATCH phone syncs the linked people row phone", async () => {
        const res = await request(app)
          .patch(`/people/tm_${syncTmId}`)
          .send({ phone: "+9990001234" });

        expect(res.status).toBe(200);

        const pplResult = await pool.query<{ phone: string }>(
          `SELECT phone FROM people WHERE id = $1`,
          [syncPersonId],
        );
        expect(pplResult.rows[0].phone).toBe("+9990001234");
      });

      it("PATCH all three fields together syncs all to the linked people row", async () => {
        const res = await request(app)
          .patch(`/people/tm_${syncTmId}`)
          .send({ first_name: "Janet", last_name: "Combined", phone: "+1112223333" });

        expect(res.status).toBe(200);

        const pplResult = await pool.query<{
          first_name: string;
          last_name: string;
          phone: string;
        }>(
          `SELECT first_name, last_name, phone FROM people WHERE id = $1`,
          [syncPersonId],
        );
        expect(pplResult.rows[0].first_name).toBe("Janet");
        expect(pplResult.rows[0].last_name).toBe("Combined");
        expect(pplResult.rows[0].phone).toBe("+1112223333");
      });

      it("response from PATCH name/phone changes contains correct non-null person_id and profile_id", async () => {
        const res = await request(app)
          .patch(`/people/tm_${syncTmId}`)
          .send({ first_name: "Janet" });

        expect(res.status).toBe(200);
        expect(res.body.person_id).not.toBeNull();
        expect(typeof res.body.person_id).toBe("number");
        expect(res.body.profile_id).not.toBeNull();
        expect(typeof res.body.profile_id).toBe("number");
      });

      it("PATCH phone cleared to empty string sets people row phone to null", async () => {
        const res = await request(app)
          .patch(`/people/tm_${syncTmId}`)
          .send({ phone: "" });

        expect(res.status).toBe(200);

        const pplResult = await pool.query<{ phone: string | null }>(
          `SELECT phone FROM people WHERE id = $1`,
          [syncPersonId],
        );
        expect(pplResult.rows[0].phone).toBeNull();
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 8. PATCH /people/:id — job_title sync to team_member_profiles row
    // ─────────────────────────────────────────────────────────────────────────

    describe("PATCH /people/:id — job_title changes keep team_member_profiles in sync", () => {
      let jtTmId: number;
      let jtProfileId: number;

      beforeAll(async () => {
        const tmResult = await pool.query<{ id: number }>(
          `INSERT INTO team_members
             (workspace_owner_id, first_name, last_name, email, employment_status)
           VALUES ($1, 'Karl', 'Jobtitle', 'karl-jt@example.com', 'full_time')
           RETURNING id`,
          [OWNER_ID],
        );
        jtTmId = tmResult.rows[0].id;

        const personResult = await pool.query<{ id: number }>(
          `INSERT INTO people
             (workspace_owner_id, first_name, last_name, email, status)
           VALUES ($1, 'Karl', 'Jobtitle', 'karl-jt@example.com', 'active')
           RETURNING id`,
          [OWNER_ID],
        );
        const jtPersonId = personResult.rows[0].id;

        const profileResult = await pool.query<{ id: number }>(
          `INSERT INTO team_member_profiles
             (person_id, workspace_owner_id, team_member_id, job_title, employment_type, status)
           VALUES ($1, $2, $3, 'Junior Engineer', 'full_time', 'active')
           RETURNING id`,
          [jtPersonId, OWNER_ID, jtTmId],
        );
        jtProfileId = profileResult.rows[0].id;
      });

      it("PATCH job_title syncs the linked team_member_profiles row job_title", async () => {
        const res = await request(app)
          .patch(`/people/tm_${jtTmId}`)
          .send({ job_title: "Senior Engineer" });

        expect(res.status).toBe(200);

        const profResult = await pool.query<{ job_title: string }>(
          `SELECT job_title FROM team_member_profiles WHERE id = $1`,
          [jtProfileId],
        );
        expect(profResult.rows[0].job_title).toBe("Senior Engineer");
      });

      it("PATCH job_title together with name changes syncs all fields", async () => {
        const res = await request(app)
          .patch(`/people/tm_${jtTmId}`)
          .send({ first_name: "Karla", job_title: "Principal Engineer" });

        expect(res.status).toBe(200);

        const profResult = await pool.query<{ job_title: string }>(
          `SELECT job_title FROM team_member_profiles WHERE id = $1`,
          [jtProfileId],
        );
        expect(profResult.rows[0].job_title).toBe("Principal Engineer");
      });

      it("PATCH job_title cleared to empty string sets team_member_profiles.job_title to null", async () => {
        const res = await request(app)
          .patch(`/people/tm_${jtTmId}`)
          .send({ job_title: "" });

        expect(res.status).toBe(200);

        const profResult = await pool.query<{ job_title: string | null }>(
          `SELECT job_title FROM team_member_profiles WHERE id = $1`,
          [jtProfileId],
        );
        expect(profResult.rows[0].job_title).toBeNull();
      });

      it("response from PATCH job_title change contains correct non-null person_id and profile_id", async () => {
        const res = await request(app)
          .patch(`/people/tm_${jtTmId}`)
          .send({ job_title: "Staff Engineer" });

        expect(res.status).toBe(200);
        expect(res.body.person_id).not.toBeNull();
        expect(typeof res.body.person_id).toBe("number");
        expect(res.body.profile_id).not.toBeNull();
        expect(typeof res.body.profile_id).toBe("number");
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 9. GET /people/:id — returns team_member_profiles.job_title
    // ─────────────────────────────────────────────────────────────────────────

    describe("GET /people/:id — job_title comes from team_member_profiles", () => {
      let profileTitleTmId: number;

      beforeAll(async () => {
        const tmResult = await pool.query<{ id: number }>(
          `INSERT INTO team_members
             (workspace_owner_id, first_name, last_name, email, employment_status)
           VALUES ($1, 'ProfileTitle', 'Test', 'profile-title@example.com', 'full_time')
           RETURNING id`,
          [OWNER_ID],
        );
        profileTitleTmId = tmResult.rows[0].id;

        const personResult = await pool.query<{ id: number }>(
          `INSERT INTO people
             (workspace_owner_id, first_name, last_name, email, status)
           VALUES ($1, 'ProfileTitle', 'Test', 'profile-title@example.com', 'active')
           RETURNING id`,
          [OWNER_ID],
        );
        const profileTitlePersonId = personResult.rows[0].id;

        await pool.query(
          `INSERT INTO team_member_profiles
             (person_id, workspace_owner_id, team_member_id, job_title, employment_type, status)
           VALUES ($1, $2, $3, 'Title From Profile', 'full_time', 'active')`,
          [profileTitlePersonId, OWNER_ID, profileTitleTmId],
        );
      });

      it("GET /people/:id returns team_member_profiles.job_title", async () => {
        const res = await request(app).get(`/people/tm_${profileTitleTmId}`);

        expect(res.status).toBe(200);
        expect(res.body.job_title).toBe("Title From Profile");
      });

      it("GET /people returns team_member_profiles.job_title in the list", async () => {
        const res = await request(app).get("/people");

        expect(res.status).toBe(200);
        const person = (res.body.people as Array<{ team_member_id: number; job_title: string | null }>)
          .find((p) => p.team_member_id === profileTitleTmId);
        expect(person).toBeDefined();
        expect(person!.job_title).toBe("Title From Profile");
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 10. POST /people — profile linkage always created with correct job_title
    //
    // This section is the primary guard against the orphan scenario described
    // in the task: if POST /people ever fails to create the team_member_profiles
    // row, or writes the wrong job_title to it, these tests will catch it.
    // ─────────────────────────────────────────────────────────────────────────


    describe("POST /people — profile linkage always created with correct job_title", () => {
      let profileTmId: number;
      let noTitleTmId: number;

      beforeAll(async () => {
        // Create the two people used across this describe block up front so
        // subsequent `it` tests can assert on them individually.
        const res1 = await request(app).post("/people").send({
          first_name: "Link",
          last_name: "WithTitle",
          email: "link-withtitle@example.com",
          job_title: "Product Manager",
          employment_status: "full_time",
        });
        profileTmId = (res1.body as Record<string, number>).team_member_id;

        const res2 = await request(app).post("/people").send({
          first_name: "Link",
          last_name: "NoTitle",
          email: "link-notitle@example.com",
          employment_status: "full_time",
        });
        noTitleTmId = (res2.body as Record<string, number>).team_member_id;
      });

      it("POST response job_title matches the submitted job_title", async () => {
        const res = await request(app).post("/people").send({
          first_name: "Assert",
          last_name: "JobTitle",
          email: "assert-jobtitle@example.com",
          job_title: "Staff Designer",
          employment_status: "full_time",
        });

        expect(res.status).toBe(201);
        expect(res.body.job_title).toBe("Staff Designer");
      });

      it("POST response job_title is null when no job_title is submitted", async () => {
        const res = await request(app).post("/people").send({
          first_name: "Assert",
          last_name: "NoTitle",
          email: "assert-notitle@example.com",
          employment_status: "full_time",
        });

        expect(res.status).toBe(201);
        expect(res.body.job_title).toBeNull();
      });

      it("team_member_profiles row is created immediately (no orphan) after POST /people", async () => {
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM team_member_profiles
            WHERE workspace_owner_id = $1 AND team_member_id = $2`,
          [OWNER_ID, profileTmId],
        );
        expect(parseInt(result.rows[0].count, 10)).toBe(1);
      });

      it("team_member_profiles.job_title matches what was submitted to POST /people", async () => {
        const result = await pool.query<{ job_title: string | null }>(
          `SELECT job_title
             FROM team_member_profiles
            WHERE workspace_owner_id = $1 AND team_member_id = $2`,
          [OWNER_ID, profileTmId],
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].job_title).toBe("Product Manager");
      });

      it("team_member_profiles.job_title is null when no job_title was submitted", async () => {
        const result = await pool.query<{ job_title: string | null }>(
          `SELECT job_title
             FROM team_member_profiles
            WHERE workspace_owner_id = $1 AND team_member_id = $2`,
          [OWNER_ID, noTitleTmId],
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].job_title).toBeNull();
      });

      it("GET /people returns team_member_profiles.job_title immediately after POST (no migration needed)", async () => {
        const res = await request(app).get("/people");

        expect(res.status).toBe(200);
        const person = (
          res.body.people as Array<{ team_member_id: number; job_title: string | null }>
        ).find((p) => p.team_member_id === profileTmId);

        expect(person).toBeDefined();
        expect(person!.job_title).toBe("Product Manager");
      });

      it("no orphan team_members rows exist for this workspace after all POST /people calls", async () => {
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM team_members tm
            WHERE tm.workspace_owner_id = $1
              AND NOT EXISTS (
                SELECT 1
                  FROM team_member_profiles tmp
                 WHERE tmp.team_member_id = tm.id
              )`,
          [OWNER_ID],
        );
        expect(parseInt(result.rows[0].count, 10)).toBe(0);
      });
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — departments-absent fallback
//
// Renames the departments table away so the LEFT JOIN in buildPeopleList
// throws a real 42P01 error.  The route must:
//   • detect "departments" in the error message
//   • set _departmentsTableExists = false
//   • retry with a plain SELECT (no JOIN) returning NULL department_name
//   • return HTTP 200 with valid people rows
//
// The departments table is renamed back in afterAll so subsequent tests
// (and the live schema) are unaffected.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "people-directory departments-absent fallback integration tests",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let deptTableRenamed = false;
    let deptAbsentTmId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Reset the module-level cache flags so this suite starts with an
      // unchecked state — the previous suite leaves them all true.
      _resetTeamMembersTableExistsForTesting();

      // Clean up any leftover rows from a previous failed run
      await pool.query(
        `DELETE FROM team_member_profiles
          WHERE workspace_owner_id = $1
            AND team_member_id IN (
              SELECT id FROM team_members
               WHERE workspace_owner_id = $1
                 AND email = 'zara-dept-absent@example.com'
            )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM team_members
          WHERE workspace_owner_id = $1
            AND email = 'zara-dept-absent@example.com'`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM people
          WHERE workspace_owner_id = $1
            AND email = 'zara-dept-absent@example.com'`,
        [OWNER_ID],
      );

      // Seed one team_member under the shared OWNER_ID (same as suite 1).
      // The workspace mock hardcodes OWNER_ID so the route will filter by it.
      const tmResult = await pool.query<{ id: number }>(
        `INSERT INTO team_members
           (workspace_owner_id, first_name, last_name, email, employment_status)
         VALUES ($1, 'Zara', 'DeptAbsent', 'zara-dept-absent@example.com', 'full_time')
         RETURNING id`,
        [OWNER_ID],
      );
      deptAbsentTmId = tmResult.rows[0].id;

      // Check that departments currently exists (it always should after Drizzle push)
      const existsResult = await pool.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name   = 'departments'
        ) AS exists
      `);
      if (existsResult.rows[0]?.exists) {
        // Rename the table so the route's LEFT JOIN fails with 42P01
        await pool.query(`ALTER TABLE departments RENAME TO departments_absent_test_bak`);
        deptTableRenamed = true;
      }
    });

    afterAll(async () => {
      if (!pool) return;

      try {
        // Reset the module-level cache so callers after this suite see a clean state
        _resetTeamMembersTableExistsForTesting();

        // Remove the seeded rows
        await pool.query(
          `DELETE FROM team_member_profiles
            WHERE workspace_owner_id = $1
              AND team_member_id = $2`,
          [OWNER_ID, deptAbsentTmId],
        );
        await pool.query(
          `DELETE FROM team_members
            WHERE workspace_owner_id = $1
              AND id = $2`,
          [OWNER_ID, deptAbsentTmId],
        );
        await pool.query(
          `DELETE FROM people
            WHERE workspace_owner_id = $1
              AND email = 'zara-dept-absent@example.com'`,
          [OWNER_ID],
        );
      } finally {
        // Restore the departments table so FK constraints from
        // team_members.department_id remain valid — runs even if cleanup throws
        if (deptTableRenamed) {
          await pool.query(`ALTER TABLE departments_absent_test_bak RENAME TO departments`);
          deptTableRenamed = false;
        }

        await pool.end();
      }
    });

    it("returns HTTP 200 with people rows when the departments table is absent", async () => {
      const res = await request(app).get("/people");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("people");

      const person = (res.body.people as Array<Record<string, unknown>>).find(
        (p) => p.team_member_id === deptAbsentTmId,
      );

      expect(person).toBeDefined();
      // The fallback query returns NULL for every department_name column
      expect(person!.department_name).toBeNull();
      // Core identity fields are still present
      expect(person!.first_name).toBe("Zara");
      expect(person!.last_name).toBe("DeptAbsent");
    });

    it("sets the departments-absent flag so subsequent calls skip the JOIN", async () => {
      // After the first call above _departmentsTableExists is false.
      // The route must issue the team_members query WITHOUT a departments JOIN,
      // so the request still succeeds even though the table remains absent.
      const res = await request(app).get("/people");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("people");

      const person = (res.body.people as Array<Record<string, unknown>>).find(
        (p) => p.team_member_id === deptAbsentTmId,
      );
      expect(person).toBeDefined();
      expect(person!.department_name).toBeNull();
    });

    it("stats block is still returned correctly when departments is absent", async () => {
      const res = await request(app).get("/people");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("stats");
      const stats = res.body.stats as Record<string, number>;
      // At least the one seeded team_member is counted
      expect(stats.totalTeamMembers).toBeGreaterThanOrEqual(1);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — departments-absent + team_members-absent double-fallback
//
// This suite exercises the second branch inside the departments-absent retry
// block: if the retry query itself also throws 42P01 (team_members is also
// absent), the route sets _teamMembersTableExists = false and falls back to
// returning a workspace_members-only list.
//
// Both tables are renamed away in beforeAll and restored in afterAll.
// The module-level cache flags are reset before and after the suite.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "people-directory departments-and-team_members-absent double-fallback integration tests",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let deptTableRenamed = false;
    let tmTableRenamed = false;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Reset the module-level cache flags so this suite starts with an
      // unchecked state — the previous suites leave them set.
      _resetTeamMembersTableExistsForTesting();

      // Rename departments away so the initial query's LEFT JOIN fails with 42P01
      const deptExistsResult = await pool.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name   = 'departments'
        ) AS exists
      `);
      if (deptExistsResult.rows[0]?.exists) {
        await pool.query(`ALTER TABLE departments RENAME TO departments_double_absent_bak`);
        deptTableRenamed = true;
      }

      // Rename team_members away so the retry query also fails with 42P01
      const tmExistsResult = await pool.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name   = 'team_members'
        ) AS exists
      `);
      if (tmExistsResult.rows[0]?.exists) {
        await pool.query(`ALTER TABLE team_members RENAME TO team_members_double_absent_bak`);
        tmTableRenamed = true;
      }
    });

    afterAll(async () => {
      if (!pool) return;

      try {
        // Restore team_members first (departments FK from team_members.department_id)
        if (tmTableRenamed) {
          await pool.query(`ALTER TABLE team_members_double_absent_bak RENAME TO team_members`);
          tmTableRenamed = false;
        }
      } finally {
        try {
          // Restore departments — runs even if the team_members restore above threw
          if (deptTableRenamed) {
            await pool.query(`ALTER TABLE departments_double_absent_bak RENAME TO departments`);
            deptTableRenamed = false;
          }
        } finally {
          // Reset the module-level cache so callers after this suite see a clean state
          _resetTeamMembersTableExistsForTesting();

          await pool.end();
        }
      }
    });

    it("returns HTTP 200 when both departments and team_members tables are absent", async () => {
      const res = await request(app).get("/people");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("people");
      expect(Array.isArray(res.body.people)).toBe(true);
    });

    it("returned rows contain no team_member_id fields (workspace_members-only fallback)", async () => {
      const res = await request(app).get("/people");

      expect(res.status).toBe(200);

      const people = res.body.people as Array<Record<string, unknown>>;
      // Every row must either lack team_member_id entirely or have it as null —
      // no team_member data can appear when the table is absent.
      for (const person of people) {
        if ("team_member_id" in person) {
          expect(person.team_member_id).toBeNull();
        }
      }
    });

    it("sets both absence flags so a second call also succeeds without touching the renamed tables", async () => {
      // After the first request in this suite _departmentsTableExists and
      // _teamMembersTableExists are both false.  The route must not attempt
      // any query against the renamed tables on this second call.
      const res = await request(app).get("/people");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("people");
      expect(Array.isArray(res.body.people)).toBe(true);
    });

    it("stats block is still present when both tables are absent", async () => {
      const res = await request(app).get("/people");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("stats");
      // Stats fields must exist even if team_member counts are zero
      const stats = res.body.stats as Record<string, unknown>;
      expect(stats).toHaveProperty("totalTeamMembers");
      expect(stats.totalTeamMembers).toBe(0);
    });
  },
);
