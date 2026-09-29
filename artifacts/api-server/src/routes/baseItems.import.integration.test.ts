/**
 * Integration tests: bulk import route (POST /base-items/import) against a
 * real PostgreSQL instance.
 *
 * Scenarios covered:
 *
 *   1.  Valid XLSX import — all rows created, created count matches
 *   2.  Valid CSV import — rows created from a CSV buffer
 *   3.  dry_run=true — returns preview_rows without writing to DB
 *   4.  Name deduplication against existing DB row — skipped with name_exists
 *   5.  Within-batch code deduplication — second row with same code is skipped
 *   6.  Category not found — warning emitted, row still inserted
 *   7.  Invalid tax category — warning emitted, row still inserted (tax_category cleared)
 *   8.  Empty file (header only) — 400 No data rows
 *   9.  Non-xlsx/csv file — 400 unsupported extension
 *  10.  No file attached — 400 file required
 *  11.  Non-owner member — 403
 *  12.  All rows skipped — returns created:0 without writing
 *  13.  Rows with no name among data rows — error status in preview_rows
 *
 * Auth and workspace middleware are stubbed; the database is real.
 * Tests seed their own rows under a unique OWNER_ID and clean up in afterAll.
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique owner so tests never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_bi_import__";
const USER_ID = "__integration_test_bi_import_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / objectStorage / clerkClient / db
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/db", async () => {
  const { default: pgLib } = await import("pg");
  const pool = new pgLib.Pool({ connectionString: process.env.DATABASE_URL });
  return { db: pool };
});

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

let mockRole: "owner" | "member" = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as import("../lib/workspace").WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = mockRole;
    wreq.workspaceActualRole = mockRole;
    wreq.userId = USER_ID;
    wreq.userEmail = "import-test@example.com";
    next();
  },
  workspace: (req: express.Request) =>
    req as unknown as import("../lib/workspace").WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    getSignedUrl: vi.fn(),
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn(),
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

vi.mock("../lib/email", () => ({
  sendLowStockAlertEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/lowStockSse", () => ({
  subscribeToLowStock: vi.fn(),
  broadcastLowStock: vi.fn(),
}));

vi.mock("@workspace/integrations-openai-ai-server/image", () => ({
  generateImageBuffer: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Import router AFTER vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import baseItemsRouter from "./baseItems";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as unknown as Record<string, any>).log = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    };
    next();
  });
  app.use(baseItemsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err?.message ?? String(err) });
  });
  return app;
}

/**
 * Build an XLSX buffer from a 2-D array where the first row is headers.
 */
async function makeXlsx(rows: string[][]): Promise<Buffer> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  rows.forEach((row) => {
    worksheet.addRow(row);
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * Build a CSV buffer from a 2-D array where the first row is headers.
 */
function makeCsv(rows: string[][]): Buffer {
  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  return Buffer.from(csv, "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "POST /base-items/import — integration (real database)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // Pre-seeded category id for resolving category names
    let categoryId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();
      mockRole = "owner";

      // Clean up leftovers from any previous failed run
      await pool.query(`DELETE FROM base_item_audit_log WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_packages WHERE base_item_id IN (SELECT id FROM base_items WHERE workspace_owner_id = $1)`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_categories WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // Seed a category so category resolution tests can work
      const catResult = await pool.query<{ id: number }>(
        `INSERT INTO base_item_categories (workspace_owner_id, name) VALUES ($1, 'Flowers') RETURNING id`,
        [OWNER_ID],
      );
      categoryId = catResult.rows[0].id;
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM base_item_audit_log WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_packages WHERE base_item_id IN (SELECT id FROM base_items WHERE workspace_owner_id = $1)`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_categories WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    // Helper: delete all base items for this owner (used between tests that need a clean slate)
    async function clearBaseItems() {
      await pool.query(`DELETE FROM base_item_audit_log WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_packages WHERE base_item_id IN (SELECT id FROM base_items WHERE workspace_owner_id = $1)`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
    }

    // ── 1. Valid XLSX import — all rows created ───────────────────────────────
    it("valid XLSX import — all rows created", async () => {
      await clearBaseItems();

      const buf = await makeXlsx([
        ["Name", "Code", "Category", "Tax Category", "Stock", "Low Stock Threshold"],
        ["Red Rose", "RR-001", "Flowers", "standard_taxable", "50", "5"],
        ["White Lily", "WL-002", "Flowers", "not_classified", "30", "3"],
      ]);

      const res = await request(app)
        .post("/base-items/import")
        .attach("file", buf, "items.xlsx");

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(2);
      expect(res.body.skipped).toHaveLength(0);

      const { rows } = await pool.query<{ name: string; code: string; tax_category: string; stock: number }>(
        `SELECT name, code, tax_category, stock FROM base_items WHERE workspace_owner_id = $1 ORDER BY name`,
        [OWNER_ID],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].name).toBe("Red Rose");
      expect(rows[0].code).toBe("RR-001");
      expect(rows[0].tax_category).toBe("standard_taxable");
      expect(Number(rows[0].stock)).toBe(50);
      expect(rows[1].name).toBe("White Lily");
    });

    // ── 2. Valid CSV import ───────────────────────────────────────────────────
    it("valid CSV import — rows created", async () => {
      await clearBaseItems();

      const buf = makeCsv([
        ["Name", "Code", "Category", "Tax Category"],
        ["Blue Iris", "BI-003", "Flowers", "standard_taxable"],
        ["Pink Peony", "PP-004", "Flowers", "exempt"],
      ]);

      const res = await request(app)
        .post("/base-items/import")
        .attach("file", buf, "items.csv");

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(2);

      const { rows } = await pool.query<{ name: string }>(
        `SELECT name FROM base_items WHERE workspace_owner_id = $1 ORDER BY name`,
        [OWNER_ID],
      );
      expect(rows.map((r) => r.name)).toEqual(["Blue Iris", "Pink Peony"]);
    });

    // ── 3. dry_run=true — preview without writing ─────────────────────────────
    it("dry_run=true — returns preview_rows, nothing written to DB", async () => {
      await clearBaseItems();

      const buf = await makeXlsx([
        ["Name", "Code"],
        ["Dry Rose", "DR-DRY"],
      ]);

      const res = await request(app)
        .post("/base-items/import?dry_run=true")
        .attach("file", buf, "items.xlsx");

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(0);
      expect(res.body.preview_rows).toHaveLength(1);
      expect(res.body.preview_rows[0]).toMatchObject({
        row: 2,
        name: "Dry Rose",
        code: "DR-DRY",
        status: "valid",
      });

      // Verify nothing was written
      const { rowCount } = await pool.query(
        `SELECT 1 FROM base_items WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      expect(rowCount ?? 0).toBe(0);
    });

    // ── 4. Name deduplication — skip rows that exist in DB ───────────────────
    it("skips rows whose name already exists in the DB", async () => {
      await clearBaseItems();

      // Pre-seed an item with the same name (case-insensitive)
      await pool.query(
        `INSERT INTO base_items (workspace_owner_id, name, code, status) VALUES ($1, 'Existing Rose', 'EX-001', 'active')`,
        [OWNER_ID],
      );

      const buf = await makeXlsx([
        ["Name", "Code"],
        ["existing rose", "ER-NEW"],  // lowercase — must be treated as duplicate
        ["New Tulip", "NT-001"],
      ]);

      const res = await request(app)
        .post("/base-items/import")
        .attach("file", buf, "items.xlsx");

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(1);
      expect(res.body.skipped).toHaveLength(1);
      expect(res.body.skipped[0]).toMatchObject({ name: "existing rose", reason: "name_exists" });

      // Confirm dry_run includes preview_rows with the skip reflected
      const buf2 = await makeXlsx([
        ["Name", "Code"],
        ["existing rose", "ER-NEW"],
        ["New Tulip", "NT-001"],
      ]);
      const dryRes = await request(app)
        .post("/base-items/import?dry_run=true")
        .attach("file", buf2, "items.xlsx");
      const skippedPreview = dryRes.body.preview_rows.find((r: { name: string }) => r.name === "existing rose");
      expect(skippedPreview?.status).toBe("skipped");
      expect(skippedPreview?.skip_reason).toBe("name_exists");
    });

    // ── 5. Within-batch code deduplication ───────────────────────────────────
    it("skips second row in batch that has the same code as a prior row", async () => {
      await clearBaseItems();

      const buf = await makeXlsx([
        ["Name", "Code"],
        ["Batch Item A", "SAME-CODE"],
        ["Batch Item B", "SAME-CODE"],  // duplicate code within batch
      ]);

      const res = await request(app)
        .post("/base-items/import")
        .attach("file", buf, "items.xlsx");

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(1);
      expect(res.body.skipped).toHaveLength(1);
      expect(res.body.skipped[0]).toMatchObject({ name: "Batch Item B", reason: "code_exists" });
    });

    // ── 6. Category not found — warning, row still inserted ──────────────────
    it("emits a category_not_found warning and still inserts the row without a category", async () => {
      await clearBaseItems();

      const buf = await makeXlsx([
        ["Name", "Code", "Category"],
        ["Mystery Item", "MI-001", "NonExistentCategory"],
      ]);

      const res = await request(app)
        .post("/base-items/import")
        .attach("file", buf, "items.xlsx");

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(1);
      const catWarning = res.body.warnings.find((w: { field: string }) => w.field === "Category");
      expect(catWarning).toBeDefined();
      expect(catWarning.message).toContain("category_not_found");

      // Item inserted with null category_id
      const { rows } = await pool.query<{ name: string; category_id: number | null }>(
        `SELECT name, category_id FROM base_items WHERE workspace_owner_id = $1 AND name = 'Mystery Item'`,
        [OWNER_ID],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].category_id).toBeNull();
    });

    // ── 7. Invalid tax category — warning, row inserted with not_classified ───
    it("emits an invalid_tax_category warning and inserts row with not_classified fallback", async () => {
      await clearBaseItems();

      const buf = await makeXlsx([
        ["Name", "Code", "Tax Category"],
        ["Tax Confused Item", "TCI-001", "super_special_tax"],
      ]);

      const res = await request(app)
        .post("/base-items/import")
        .attach("file", buf, "items.xlsx");

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(1);
      const taxWarning = res.body.warnings.find((w: { field: string }) => w.field === "Tax Category");
      expect(taxWarning).toBeDefined();
      expect(taxWarning.message).toContain("invalid_tax_category");

      // DB row should have the default tax_category
      const { rows } = await pool.query<{ tax_category: string }>(
        `SELECT tax_category FROM base_items WHERE workspace_owner_id = $1 AND name = 'Tax Confused Item'`,
        [OWNER_ID],
      );
      expect(rows[0].tax_category).toBe("not_classified");
    });

    // ── 8. Empty file (header row only) — 400 ────────────────────────────────
    it("returns 400 when file has only a header row and no data", async () => {
      const buf = await makeXlsx([
        ["Name", "Code", "Category"],
      ]);

      const res = await request(app)
        .post("/base-items/import")
        .attach("file", buf, "items.xlsx");

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no data rows/i);
    });

    // ── 9. Non-xlsx/csv extension — 400 ──────────────────────────────────────
    it("returns 400 for an unsupported file extension", async () => {
      const res = await request(app)
        .post("/base-items/import")
        .attach("file", Buffer.from("not a real file"), "items.txt");

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/xlsx|csv/i);
    });

    it("returns 400 when an .xlsx filename contains non-XLSX content", async () => {
      const res = await request(app)
        .post("/base-items/import")
        .attach("file", Buffer.from("not a real xlsx file"), "items.xlsx");

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/contents do not match.*xlsx/i);
    });

    // ── 10. No file — 400 ────────────────────────────────────────────────────
    it("returns 400 when no file is attached", async () => {
      // Send a proper multipart form with a non-file field so multer completes
      // parsing without error; req.file will be undefined, triggering the 400.
      const res = await request(app)
        .post("/base-items/import")
        .field("dummy", "value");

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/file is required/i);
    });

    // ── 11. Non-owner member — 403 ───────────────────────────────────────────
    it("returns 403 for a non-owner workspace member", async () => {
      mockRole = "member";

      const buf = await makeXlsx([
        ["Name", "Code"],
        ["Forbidden Rose", "FR-001"],
      ]);

      const res = await request(app)
        .post("/base-items/import")
        .attach("file", buf, "items.xlsx");

      expect(res.status).toBe(403);

      // Restore for subsequent tests
      mockRole = "owner";
    });

    // ── 12. All rows skipped — created:0, no DB writes ────────────────────────
    it("returns created:0 when every row is skipped (all names already exist)", async () => {
      await clearBaseItems();

      // Pre-seed both names
      await pool.query(
        `INSERT INTO base_items (workspace_owner_id, name, code, status) VALUES ($1, 'Already Item A', 'AIA-001', 'active'), ($1, 'Already Item B', 'AIB-001', 'active')`,
        [OWNER_ID],
      );

      const buf = await makeXlsx([
        ["Name", "Code"],
        ["Already Item A", "AIA-002"],
        ["Already Item B", "AIB-002"],
      ]);

      const res = await request(app)
        .post("/base-items/import")
        .attach("file", buf, "items.xlsx");

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(0);
      expect(res.body.skipped).toHaveLength(2);

      // No new items were added beyond the two we seeded
      const { rowCount } = await pool.query(
        `SELECT 1 FROM base_items WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      expect(rowCount).toBe(2);
    });

    // ── 13. Rows missing Name — error status in preview_rows ─────────────────
    it("marks rows with missing Name as error in preview_rows and still imports valid rows", async () => {
      await clearBaseItems();

      const buf = await makeXlsx([
        ["Name", "Code"],
        ["Valid Item X", "VIX-001"],
        ["", "NO-NAME-CODE"],          // has data but no name
        ["Valid Item Y", "VIY-002"],
      ]);

      const res = await request(app)
        .post("/base-items/import?dry_run=true")
        .attach("file", buf, "items.xlsx");

      expect(res.status).toBe(200);

      const errorRows = res.body.preview_rows.filter((r: { status: string }) => r.status === "error");
      expect(errorRows).toHaveLength(1);
      expect(errorRows[0].error_reason).toBe("missing_name");

      const validRows = res.body.preview_rows.filter((r: { status: string }) => r.status === "valid");
      expect(validRows).toHaveLength(2);
    });
  },
);
