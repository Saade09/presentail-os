/**
 * Integration tests: confirm each PostgreSQL transaction in the API server
 * actually rolls back when a mid-operation failure occurs, leaving no partial
 * state in a real database.
 *
 * These tests call the REAL route handlers via HTTP so that any mis-wiring of
 * the transaction (wrong client, missing BEGIN, missing ROLLBACK, wrong SQL
 * order) is caught.  Auth and email middleware are stubbed out; everything
 * else — including the database — is real.
 *
 * Fault injection strategy
 * ────────────────────────
 * db.connect() is intercepted at the module level via vi.mock with
 * importOriginal.  Two module-level variables control per-test injection:
 *
 *   injectFault        — enable fault injection for the next HTTP request
 *   injectFaultOnWrite — which write number (1-indexed) to fail on
 *                        (defaults to 2; set to 1 for single-write routes)
 *
 * When active the wrapper returns the real PoolClient with its `query`
 * method overridden so that the N-th write query (INSERT / UPDATE / DELETE)
 * throws.  The route's catch block then issues ROLLBACK through the same
 * client (which passes it through to the real database), and the test
 * verifies no partial state was committed.
 *
 * Six routes are covered:
 *  1. POST /access-requests/:id/approve — workspace_members INSERT + access_requests UPDATE
 *  2. POST /users                       — workspace_members INSERT + access_requests UPDATE
 *  3. POST /brands                      — brands INSERT + brand_logos INSERT
 *  4. PATCH /brands/:id/logo            — brand_logos UPDATE + brands UPDATE (legacy column)
 *  5. PUT /users/:id/locations          — member_locations DELETE + member_locations INSERT
 *  6. DELETE /brands/:id/logos/:logoId  — brand_logos soft-delete UPDATE (single write)
 *
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import zlib from "zlib";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Module-level fault injection controls.
// Tests set these before an HTTP request and restore them after (finally block).
// ─────────────────────────────────────────────────────────────────────────────
let injectFault = false;
/** Which write (1-indexed) should throw. Default 2 for two-write transactions. */
let injectFaultOnWrite = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / side-effects only.
// db is partially mocked: pool queries use the real pool; db.connect() wraps
// the real PoolClient with fault injection when `injectFault` is true.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/db", async (importOriginal) => {
  const realModule = await importOriginal<typeof import("../lib/db")>();
  const realDb = realModule.db;

  return {
    db: {
      // Pool-level query calls (pre-checks in routes) use the real pool.
      query: (...args: Parameters<typeof realDb.query>) => realDb.query(...args),

      // db.connect() returns either the real client or a fault-injecting wrapper.
      connect: async () => {
        const realClient = await realDb.connect();
        if (!injectFault) return realClient;

        // Remove any own `query` property left by a previous test run on this
        // recycled connection so `realClient.query` falls back to the prototype.
        delete (realClient as unknown as Record<string, unknown>)["query"];

        // Capture the prototype's original method, bound to the real client.
        const origQuery = (realClient.query as (...a: unknown[]) => unknown).bind(realClient);

        let writeCount = 0;
        const failAt = injectFaultOnWrite; // capture at client-creation time
        Object.defineProperty(realClient, "query", {
          configurable: true,
          writable: true,
          value: (sqlOrConfig: unknown, ...rest: unknown[]) => {
            const sql =
              typeof sqlOrConfig === "string"
                ? sqlOrConfig
                : (sqlOrConfig as { text?: string })?.text ?? "";
            const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
            if (isWrite) {
              writeCount++;
              if (writeCount >= failAt) {
                throw new Error(
                  `[Fault Injection] Simulated crash on write #${writeCount} in transaction`,
                );
              }
            }
            return origQuery(sqlOrConfig, ...rest);
          },
        });

        return realClient;
      },
    },
  };
});

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/email", () => ({
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
  sendAccessRejectionEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/accessRequestSse", () => ({
  subscribe: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock("@clerk/express", () => ({
  clerkClient: { users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) } },
}));

let stubOwnerId = "__txn_route_rollback__";
let stubRole: "owner" | "member" = "owner";
let stubUserId = "__txn_test_user__";
let stubUserEmail: string | null = "txn-owner@example.com";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubOwnerId;
    wreq.workspaceRole = stubRole;
    wreq.workspaceActualRole = stubRole;
    wreq.userId = stubUserId;
    wreq.userEmail = stubUserEmail;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

// ─────────────────────────────────────────────────────────────────────────────
// Imports — MUST come after vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import accessRequestsRouter from "./accessRequests";
import usersRouter from "./users";
import brandsRouter from "./brands";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__txn_route_rollback__";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a minimal valid 200×200 PNG buffer that passes the imageSize()
 * dimension check in the brand logo upload routes.
 */
function makeTestPng(): Buffer {
  function crc32(buf: Buffer): number {
    const table: number[] = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++)
      crc = (table[(crc ^ buf[i]) & 0xff] ?? 0) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crcBuf]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(200, 0);
  ihdr.writeUInt32BE(200, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const row = Buffer.alloc(1 + 200 * 3, 0);
  const raw = Buffer.concat(Array(200).fill(row));
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeApp(router: express.Router): express.Express {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

async function cleanupTestData(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(
    `DELETE FROM member_locations WHERE member_id IN (
       SELECT id FROM workspace_members WHERE workspace_owner_id = $1
     )`,
    [OWNER_ID],
  );
  await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM brand_logos WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM brands WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM workspace_roles WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(
    `DELETE FROM access_requests WHERE requester_email LIKE 'txn-route-%@example.com'`,
  );
}

async function seedWorkspaceRole(pool: InstanceType<typeof Pool>): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO workspace_roles (workspace_owner_id, name, allowed_pages)
     VALUES ($1, 'Test Role', '[]'::jsonb)
     RETURNING id`,
    [OWNER_ID],
  );
  return result.rows[0].id;
}

async function seedAccessRequest(
  pool: InstanceType<typeof Pool>,
  email: string,
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO access_requests (requester_email, status) VALUES ($1, 'pending') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

/** Seed a brand with ONE logo (used by update-logo test). */
async function seedBrandWithLogo(
  pool: InstanceType<typeof Pool>,
  brandName: string,
): Promise<{ brandId: number; logoId: number }> {
  const logo = Buffer.from("original-logo-bytes-for-update-test");
  const brandResult = await pool.query<{ id: number }>(
    `INSERT INTO brands (workspace_owner_id, name, logo_data, logo_mime)
     VALUES ($1, $2, $3, 'image/png') RETURNING id`,
    [OWNER_ID, brandName, logo],
  );
  const brandId = brandResult.rows[0].id;
  const logoResult = await pool.query<{ id: number }>(
    `INSERT INTO brand_logos (brand_id, workspace_owner_id, logo_data, logo_mime, sort_order)
     VALUES ($1, $2, $3, 'image/png', 0) RETURNING id`,
    [brandId, OWNER_ID, logo],
  );
  return { brandId, logoId: logoResult.rows[0].id };
}

/**
 * Seed a brand with TWO active logos (used by logo-delete test).
 * The route refuses to delete the last logo (409), so we need at least two.
 */
async function seedBrandWithTwoLogos(
  pool: InstanceType<typeof Pool>,
): Promise<{ brandId: number; logo1Id: number; logo2Id: number }> {
  const logo = Buffer.from("original-logo-bytes-for-delete-test");
  const brandResult = await pool.query<{ id: number }>(
    `INSERT INTO brands (workspace_owner_id, name, logo_data, logo_mime)
     VALUES ($1, 'Logo Delete Test Brand', $2, 'image/png') RETURNING id`,
    [OWNER_ID, logo],
  );
  const brandId = brandResult.rows[0].id;
  const l1 = await pool.query<{ id: number }>(
    `INSERT INTO brand_logos (brand_id, workspace_owner_id, logo_data, logo_mime, sort_order)
     VALUES ($1, $2, $3, 'image/png', 0) RETURNING id`,
    [brandId, OWNER_ID, logo],
  );
  const l2 = await pool.query<{ id: number }>(
    `INSERT INTO brand_logos (brand_id, workspace_owner_id, logo_data, logo_mime, sort_order)
     VALUES ($1, $2, $3, 'image/png', 1) RETURNING id`,
    [brandId, OWNER_ID, logo],
  );
  return { brandId, logo1Id: l1.rows[0].id, logo2Id: l2.rows[0].id };
}

async function seedMemberWithLocations(
  pool: InstanceType<typeof Pool>,
): Promise<{ memberId: number; locationIds: number[] }> {
  const memberResult = await pool.query<{ id: number }>(
    `INSERT INTO workspace_members
       (workspace_owner_id, member_email, role, invited_by_user_id, invited_by_email)
     VALUES ($1, 'txn-route-member@example.com', 'member', $2, $3) RETURNING id`,
    [OWNER_ID, stubUserId, stubUserEmail],
  );
  const memberId = memberResult.rows[0].id;

  const locA = await pool.query<{ id: number }>(
    `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'TXN Route Loc A') RETURNING id`,
    [OWNER_ID],
  );
  const locB = await pool.query<{ id: number }>(
    `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'TXN Route Loc B') RETURNING id`,
    [OWNER_ID],
  );
  const locationIds = [locA.rows[0].id, locB.rows[0].id];

  await pool.query(
    `INSERT INTO member_locations (member_id, location_id) VALUES ($1, $2), ($1, $3)`,
    [memberId, locationIds[0], locationIds[1]],
  );

  return { memberId, locationIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: This suite uses module-level mutable globals (injectFault,
// injectFaultOnWrite) so tests MUST run sequentially — which is vitest's
// default for a single describe block.  Do not enable file-level concurrency
// (e.g. --pool=forks with concurrent:true) without converting these to
// async-local storage or a per-test mock factory.
describe.skipIf(!DATABASE_URL)(
  "route transaction rollback — real route handlers, real database (integration)",
  () => {
    let verifyPool: InstanceType<typeof Pool>;
    let roleId: number;
    let updateLogoBrandId: number;
    let updateLogoId: number;
    let deleteLogoBrandId: number;
    let deleteLogoTargetId: number;
    let memberId: number;
    let locationIds: number[];

    const TEST_PNG = makeTestPng();

    beforeEach(() => {
      // Reset fault-injection globals in case a previous test failed before its
      // finally block could run.
      injectFault = false;
      injectFaultOnWrite = 2;
    });

    beforeAll(async () => {
      verifyPool = new Pool({ connectionString: DATABASE_URL });
      await cleanupTestData(verifyPool);

      stubOwnerId = OWNER_ID;
      roleId = await seedWorkspaceRole(verifyPool);

      // Brand used by update-logo test (single logo)
      ({ brandId: updateLogoBrandId, logoId: updateLogoId } = await seedBrandWithLogo(
        verifyPool,
        "Logo Update Test Brand",
      ));

      // Brand used by logo-delete test (two logos so the delete is not blocked)
      ({ brandId: deleteLogoBrandId, logo1Id: deleteLogoTargetId } =
        await seedBrandWithTwoLogos(verifyPool));

      ({ memberId, locationIds } = await seedMemberWithLocations(verifyPool));
    });

    afterAll(async () => {
      if (!verifyPool) return;
      await cleanupTestData(verifyPool);
      await verifyPool.end();
    });

    // ─────────────────────────────────────────────────────────────────────
    // 1. Approve access request
    //    POST /access-requests/:id/approve
    //    Transaction: INSERT workspace_members + UPDATE access_requests
    // ─────────────────────────────────────────────────────────────────────
    it(
      "approve-access-request rollback: no workspace_members row persists and " +
        "access_request remains 'pending' when the second write fails",
      async () => {
        const email = "txn-route-approve@example.com";
        const requestId = await seedAccessRequest(verifyPool, email);

        injectFault = true;
        injectFaultOnWrite = 2;
        try {
          await request(makeApp(accessRequestsRouter))
            .post(`/access-requests/${requestId}/approve`)
            .send({ roleId })
            .expect(500);
        } finally {
          injectFault = false;
          injectFaultOnWrite = 2;
        }

        const memberResult = await verifyPool.query(
          `SELECT id FROM workspace_members WHERE workspace_owner_id = $1 AND member_email = $2`,
          [OWNER_ID, email],
        );
        expect(
          memberResult.rowCount,
          "workspace_members row must not exist after rollback",
        ).toBe(0);

        const arResult = await verifyPool.query<{ status: string }>(
          `SELECT status FROM access_requests WHERE id = $1`,
          [requestId],
        );
        expect(
          arResult.rows[0].status,
          "access_request must still be 'pending' after rollback",
        ).toBe("pending");

        await verifyPool.query(`DELETE FROM access_requests WHERE id = $1`, [requestId]);
      },
    );

    // ─────────────────────────────────────────────────────────────────────
    // 2. Invite user
    //    POST /users
    //    Transaction: INSERT workspace_members + UPDATE access_requests (dismiss)
    // ─────────────────────────────────────────────────────────────────────
    it(
      "invite-user rollback: no workspace_members row persists and the pending " +
        "access_request is not dismissed when the second write fails",
      async () => {
        const email = "txn-route-invite@example.com";
        const requestId = await seedAccessRequest(verifyPool, email);

        injectFault = true;
        injectFaultOnWrite = 2;
        try {
          await request(makeApp(usersRouter))
            .post("/users")
            .send({ email, roleId })
            .expect(500);
        } finally {
          injectFault = false;
          injectFaultOnWrite = 2;
        }

        const memberResult = await verifyPool.query(
          `SELECT id FROM workspace_members WHERE workspace_owner_id = $1 AND member_email = $2`,
          [OWNER_ID, email],
        );
        expect(
          memberResult.rowCount,
          "workspace_members row must not exist after rollback",
        ).toBe(0);

        const arResult = await verifyPool.query<{ status: string }>(
          `SELECT status FROM access_requests WHERE id = $1`,
          [requestId],
        );
        expect(
          arResult.rows[0].status,
          "access_request must still be 'pending' after rollback",
        ).toBe("pending");

        await verifyPool.query(`DELETE FROM access_requests WHERE id = $1`, [requestId]);
      },
    );

    // ─────────────────────────────────────────────────────────────────────
    // 3. Create brand
    //    POST /brands
    //    Transaction: INSERT brands + INSERT brand_logos
    // ─────────────────────────────────────────────────────────────────────
    it(
      "create-brand rollback: neither the brands row nor any brand_logos row " +
        "persists when the second INSERT fails",
      async () => {
        const brandName = "TXN Route Rollback Test Brand";

        // Record how many brand_logos exist for this workspace BEFORE the request
        const beforeCount = await verifyPool.query<{ cnt: string }>(
          `SELECT count(*) AS cnt FROM brand_logos WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        const logosCountBefore = parseInt(beforeCount.rows[0].cnt, 10);

        injectFault = true;
        injectFaultOnWrite = 2;
        try {
          await request(makeApp(brandsRouter))
            .post("/brands")
            .field("name", brandName)
            .attach("logo", TEST_PNG, { filename: "test.png", contentType: "image/png" })
            .expect(500);
        } finally {
          injectFault = false;
          injectFaultOnWrite = 2;
        }

        // brands row must be gone
        const brandsResult = await verifyPool.query(
          `SELECT id FROM brands WHERE workspace_owner_id = $1 AND lower(name) = lower($2)`,
          [OWNER_ID, brandName],
        );
        expect(brandsResult.rowCount, "brands row must not exist after rollback").toBe(0);

        // brand_logos count must be unchanged (no orphan row)
        const afterCount = await verifyPool.query<{ cnt: string }>(
          `SELECT count(*) AS cnt FROM brand_logos WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        const logosCountAfter = parseInt(afterCount.rows[0].cnt, 10);
        expect(
          logosCountAfter,
          "brand_logos row count must be unchanged after rollback",
        ).toBe(logosCountBefore);
      },
    );

    // ─────────────────────────────────────────────────────────────────────
    // 4. Update logo  PATCH /brands/:id/logo
    //    Transaction: UPDATE brand_logos + UPDATE brands (legacy column)
    // ─────────────────────────────────────────────────────────────────────
    it(
      "update-logo rollback: brand_logos.logo_data and brands.logo_data both " +
        "remain at their original bytes when the second UPDATE fails",
      async () => {
        const origLogoData = (
          await verifyPool.query<{ logo_data: Buffer }>(
            `SELECT logo_data FROM brand_logos WHERE id = $1`,
            [updateLogoId],
          )
        ).rows[0].logo_data;

        injectFault = true;
        injectFaultOnWrite = 2;
        try {
          await request(makeApp(brandsRouter))
            .patch(`/brands/${updateLogoBrandId}/logo`)
            .attach("logo", TEST_PNG, { filename: "new.png", contentType: "image/png" })
            .expect(500);
        } finally {
          injectFault = false;
          injectFaultOnWrite = 2;
        }

        const logoResult = await verifyPool.query<{ logo_data: Buffer }>(
          `SELECT logo_data FROM brand_logos WHERE id = $1`,
          [updateLogoId],
        );
        expect(logoResult.rowCount).toBe(1);
        expect(
          Buffer.compare(logoResult.rows[0].logo_data, origLogoData),
          "brand_logos.logo_data must be unchanged after rollback",
        ).toBe(0);

        const brandResult = await verifyPool.query<{ logo_data: Buffer }>(
          `SELECT logo_data FROM brands WHERE id = $1`,
          [updateLogoBrandId],
        );
        expect(brandResult.rowCount).toBe(1);
        expect(
          Buffer.compare(brandResult.rows[0].logo_data, origLogoData),
          "brands.logo_data must be unchanged after rollback",
        ).toBe(0);
      },
    );

    // ─────────────────────────────────────────────────────────────────────
    // 5. Update member locations  PUT /users/:id/locations
    //    Transaction: DELETE member_locations + INSERT member_locations
    // ─────────────────────────────────────────────────────────────────────
    it(
      "update-locations rollback: all original member_locations rows survive " +
        "when the INSERT fails after DELETE",
      async () => {
        injectFault = true;
        injectFaultOnWrite = 2;
        try {
          await request(makeApp(usersRouter))
            .put(`/users/${memberId}/locations`)
            .send({ locationIds })
            .expect(500);
        } finally {
          injectFault = false;
          injectFaultOnWrite = 2;
        }

        const locResult = await verifyPool.query<{ location_id: number }>(
          `SELECT location_id FROM member_locations WHERE member_id = $1 ORDER BY location_id`,
          [memberId],
        );
        const persistedIds = locResult.rows.map((r) => r.location_id).sort((a, b) => a - b);
        const expectedIds = [...locationIds].sort((a, b) => a - b);

        expect(
          persistedIds,
          "all original member_locations must survive the rollback",
        ).toEqual(expectedIds);
      },
    );

    // ─────────────────────────────────────────────────────────────────────
    // 6. Soft-delete logo  DELETE /brands/:id/logos/:logoId
    //    Transaction: SELECT FOR UPDATE (lock) + UPDATE brand_logos (soft-delete)
    //    Note: only ONE write query — fail on write #1.
    //    The brand is seeded with two logos so the "last logo" guard passes.
    // ─────────────────────────────────────────────────────────────────────
    it(
      "logo-delete rollback: brand_logos.deleted_at remains NULL when the " +
        "soft-delete UPDATE fails inside the transaction",
      async () => {
        // Confirm the logo is active before the test
        const beforeResult = await verifyPool.query<{ deleted_at: Date | null }>(
          `SELECT deleted_at FROM brand_logos WHERE id = $1`,
          [deleteLogoTargetId],
        );
        expect(beforeResult.rows[0].deleted_at, "logo must be active before test").toBeNull();

        injectFault = true;
        injectFaultOnWrite = 1; // single-write route: fail on first write
        try {
          await request(makeApp(brandsRouter))
            .delete(`/brands/${deleteLogoBrandId}/logos/${deleteLogoTargetId}`)
            .expect(500);
        } finally {
          injectFault = false;
          injectFaultOnWrite = 2;
        }

        const afterResult = await verifyPool.query<{ deleted_at: Date | null }>(
          `SELECT deleted_at FROM brand_logos WHERE id = $1`,
          [deleteLogoTargetId],
        );
        expect(
          afterResult.rows[0].deleted_at,
          "brand_logos.deleted_at must remain NULL after rollback",
        ).toBeNull();
      },
    );
  },
);
