/**
 * Integration tests: supplier duplicate detection.
 *
 * Verifies:
 *   - GET /suppliers/check-duplicate — exact match, similar match (score ≥ 85),
 *     no match, and empty-name 400 error
 *   - POST /suppliers — 409 returned when an exact-match supplier already exists
 *
 * Auth and workspace middleware are stubbed. The database is real.
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__dup_detection_test_owner__";
const USER_ID = "__dup_detection_test_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / clerk only. db is NOT mocked.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (_req: express.Request) => ({ userId: USER_ID }),
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
    wreq.userEmail = "dup-test@example.com";
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

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    uploadObject: vi.fn(),
    deleteObject: vi.fn(),
  },
}));

import suppliersRouter from "./suppliers";

// ─────────────────────────────────────────────────────────────────────────────
// Express app fixture
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(suppliersRouter);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("TEST APP ERROR:", err?.message, err?.stack?.split("\n")[1]);
      res.status(500).json({ error: err?.message ?? "Internal server error" });
    },
  );
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Supplier duplicate detection — HTTP endpoint behaviour (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let seededSupplierId: number;
    let seededDisplayNameSupplierId: number;
    let seededPatchTargetId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);

      const result = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Acme Corp') RETURNING id`,
        [OWNER_ID],
      );
      seededSupplierId = result.rows[0].id;

      // Seed a supplier whose display_name differs from its canonical name.
      // This exercises the display_name comparison branches in both
      // check-duplicate and POST /suppliers.
      const result2 = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name, display_name)
         VALUES ($1, 'Globex Inc', 'Globex') RETURNING id`,
        [OWNER_ID],
      );
      seededDisplayNameSupplierId = result2.rows[0].id;

      // Seed a supplier used as the target for PATCH display_name collision tests.
      // It starts with a null display_name so we can freely update it in tests.
      const result3 = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'PatchTarget Corp') RETURNING id`,
        [OWNER_ID],
      );
      seededPatchTargetId = result3.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /suppliers/check-duplicate — input validation
    // ─────────────────────────────────────────────────────────────────────

    it("returns 400 when name query param is absent", async () => {
      const res = await request(app).get("/suppliers/check-duplicate");

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when name query param is an empty string", async () => {
      const res = await request(app).get("/suppliers/check-duplicate?name=");

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /suppliers/check-duplicate — exact match
    // ─────────────────────────────────────────────────────────────────────

    it("returns exactMatch: true for an identical name", async () => {
      const res = await request(app).get("/suppliers/check-duplicate?name=Acme+Corp");

      expect(res.status).toBe(200);
      expect(res.body.exactMatch).toBe(true);
      expect(res.body.similarMatches).toHaveLength(1);
      expect(res.body.similarMatches[0]).toMatchObject({
        id: seededSupplierId,
        name: "Acme Corp",
        score: 100,
      });
    });

    it("returns exactMatch: true for the same name with a stripped suffix variant", async () => {
      const res = await request(app).get("/suppliers/check-duplicate?name=Acme+Corp+LLC");

      expect(res.status).toBe(200);
      expect(res.body.exactMatch).toBe(true);
    });

    it("returns exactMatch: true for a case-insensitive duplicate", async () => {
      const res = await request(app).get("/suppliers/check-duplicate?name=ACME+CORP");

      expect(res.status).toBe(200);
      expect(res.body.exactMatch).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /suppliers/check-duplicate — similar match (score ≥ 85, < 100)
    // ─────────────────────────────────────────────────────────────────────

    it("returns exactMatch: false with a similar match when one character differs", async () => {
      // "Akme Corp" vs stored "Acme Corp" → 1 edit / 9 chars → score ≈ 89
      const res = await request(app).get("/suppliers/check-duplicate?name=Akme+Corp");

      expect(res.status).toBe(200);
      expect(res.body.exactMatch).toBe(false);
      expect(res.body.similarMatches).toHaveLength(1);
      expect(res.body.similarMatches[0].score).toBeGreaterThanOrEqual(85);
      expect(res.body.similarMatches[0].score).toBeLessThan(100);
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /suppliers/check-duplicate — no match
    // ─────────────────────────────────────────────────────────────────────

    it("returns exactMatch: false with empty similarMatches for a completely different name", async () => {
      const res = await request(app).get(
        "/suppliers/check-duplicate?name=Totally+Different+Zzzz",
      );

      expect(res.status).toBe(200);
      expect(res.body.exactMatch).toBe(false);
      expect(res.body.similarMatches).toHaveLength(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /suppliers — 409 duplicate guard
    // ─────────────────────────────────────────────────────────────────────

    it("returns 409 when POSTing a name that already exists (exact match)", async () => {
      const res = await request(app)
        .post("/suppliers")
        .send({ name: "Acme Corp" });

      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty("error");
      expect(res.body.existingId).toBe(seededSupplierId);
    });

    it("returns 409 when POSTing a suffix variant that normalizes to the same name", async () => {
      const res = await request(app)
        .post("/suppliers")
        .send({ name: "Acme Corp Ltd" });

      expect(res.status).toBe(409);
      expect(res.body.existingId).toBe(seededSupplierId);
    });

    it("returns 409 for a case-insensitive duplicate on POST", async () => {
      const res = await request(app)
        .post("/suppliers")
        .send({ name: "ACME CORP" });

      expect(res.status).toBe(409);
      expect(res.body.existingId).toBe(seededSupplierId);
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /suppliers/check-duplicate — display_name detection
    // ─────────────────────────────────────────────────────────────────────

    it("returns exactMatch: true when querying by an existing supplier's display_name", async () => {
      // "Globex" is the display_name of the seeded "Globex Inc" supplier.
      const res = await request(app).get("/suppliers/check-duplicate?name=Globex");

      expect(res.status).toBe(200);
      expect(res.body.exactMatch).toBe(true);
      expect(res.body.similarMatches.some((m: { id: number }) => m.id === seededDisplayNameSupplierId)).toBe(true);
    });

    it("returns exactMatch: true when querying the canonical name of a supplier that has a display_name set", async () => {
      // "Globex Inc" is the canonical name; detection should still work via the name field.
      const res = await request(app).get("/suppliers/check-duplicate?name=Globex+Inc");

      expect(res.status).toBe(200);
      expect(res.body.exactMatch).toBe(true);
      expect(res.body.similarMatches.some((m: { id: number }) => m.id === seededDisplayNameSupplierId)).toBe(true);
    });

    it("returns exactMatch: false and no similar matches when existing supplier has null display_name and input differs from name", async () => {
      // "Acme Corp" has display_name = null. A completely unrelated input must not
      // generate a false-positive match via the null display_name branch.
      const res = await request(app).get(
        "/suppliers/check-duplicate?name=UniqueXyz99999",
      );

      expect(res.status).toBe(200);
      expect(res.body.exactMatch).toBe(false);
      expect(res.body.similarMatches).toHaveLength(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /suppliers — display_name cross-field duplicate guard
    // ─────────────────────────────────────────────────────────────────────

    it("returns 409 when new supplier's name matches an existing supplier's display_name", async () => {
      // Posting name="Globex" should collide with the seeded supplier whose
      // display_name is "Globex" (canonical name "Globex Inc").
      const res = await request(app)
        .post("/suppliers")
        .send({ name: "Globex" });

      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty("error");
      expect(res.body.existingId).toBe(seededDisplayNameSupplierId);
    });

    it("returns 409 when new supplier's display_name matches an existing supplier's name", async () => {
      // Posting display_name="Acme Corp" should collide with the seeded supplier
      // whose canonical name is "Acme Corp".
      const res = await request(app)
        .post("/suppliers")
        .send({ name: "Totally Different Name", display_name: "Acme Corp" });

      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty("error");
      expect(res.body.existingId).toBe(seededSupplierId);
    });

    it("returns 409 when new supplier's display_name matches an existing supplier's display_name", async () => {
      // Posting display_name="Globex" should collide with the seeded supplier
      // whose display_name is also "Globex".
      const res = await request(app)
        .post("/suppliers")
        .send({ name: "Another Canonical Name", display_name: "Globex" });

      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty("error");
      expect(res.body.existingId).toBe(seededDisplayNameSupplierId);
    });

    // ─────────────────────────────────────────────────────────────────────
    // PATCH /suppliers/:id — display_name duplicate guard
    // ─────────────────────────────────────────────────────────────────────

    it("returns 409 when PATCHing display_name to match an existing supplier's name", async () => {
      // "Acme Corp" is the canonical name of the first seeded supplier.
      // Updating PatchTarget Corp's display_name to "Acme Corp" should collide.
      const res = await request(app)
        .patch(`/suppliers/${seededPatchTargetId}`)
        .send({ display_name: "Acme Corp" });

      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty("error");
      expect(res.body.existingId).toBe(seededSupplierId);
    });

    it("returns 409 when PATCHing display_name to match an existing supplier's display_name", async () => {
      // "Globex" is the display_name of "Globex Inc".
      // Updating PatchTarget Corp's display_name to "Globex" should collide.
      const res = await request(app)
        .patch(`/suppliers/${seededPatchTargetId}`)
        .send({ display_name: "Globex" });

      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty("error");
      expect(res.body.existingId).toBe(seededDisplayNameSupplierId);
    });

    it("does not return 409 when PATCHing display_name to a value that doesn't match any existing supplier", async () => {
      // "Acme Corp" has null display_name. Setting PatchTarget Corp's display_name
      // to a completely unique value must not produce a false-positive collision.
      const res = await request(app)
        .patch(`/suppliers/${seededPatchTargetId}`)
        .send({ display_name: "UniqueDisplayNameZzz99999" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("supplier");
    });

  },
);
