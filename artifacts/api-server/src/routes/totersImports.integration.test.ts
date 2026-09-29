/**
 * Integration tests: Toters CSV import routes against a real PostgreSQL
 * instance.
 *
 * Scenarios covered:
 *
 *   1.  Preview — counts detected rows, new orders, duplicates, invalid rows,
 *       excluded non-arrived orders, and revenue to add; writes nothing
 *   2.  Confirmed import — inserts orders + batch, reports revenue added
 *   3.  Reimporting the same file — zero inserts, zero revenue added
 *   4.  Overlapping file — only new order codes inserted
 *   5.  Concurrent imports — DB unique constraint prevents duplicates
 *   6.  Fingerprint fallback — rows without a Code dedupe on content
 *   7.  arrived-only revenue — non-arrived orders stored but add no revenue
 *   8.  Aggregate-then-round — synthesized 394-order file totals $21,022.60
 *   9.  Non-owner member — 403
 *  10.  Missing required columns — 400
 *  11.  Import history lists past batches
 *
 * Auth and workspace middleware are stubbed; the database is real.
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__integration_test_toters__";
const USER_ID = "__integration_test_toters_user__";

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
    wreq.userEmail = "toters-test@example.com";
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

import totersImportsRouter from "./totersImports";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).log = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    };
    next();
  });
  app.use(totersImportsRouter);
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err?.message ?? String(err) });
    },
  );
  return app;
}

const HEADER =
  "Code,Client First Name,Store,status,Order Time,Delivery Time,Arrived Time,Approved On,Marked As Ready Time,Preparation Time,Preparation Performance,Items Total,applied_promos,applicable_vouchers";

function csvRow(over: Partial<Record<string, string>> = {}): string {
  const base: Record<string, string> = {
    Code: "T-1",
    "Client First Name": "Rana",
    Store: "Presentail Achrafieh",
    status: "arrived",
    "Order Time": "2026-08-01 10:00:00",
    "Delivery Time": "2026-08-01 11:00:00",
    "Arrived Time": "2026-08-01 11:05:00",
    "Approved On": "2026-08-01 10:01:00",
    "Marked As Ready Time": "2026-08-01 10:30:00",
    "Preparation Time": "29",
    "Preparation Performance": "on_time",
    "Items Total": "4200.00",
    applied_promos: "",
    applicable_vouchers: "",
    ...over,
  };
  return HEADER.split(",")
    .map((h) => base[h] ?? "")
    .join(",");
}

function csvFile(rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join("\n"), "utf-8");
}

const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf("Toters imports (integration)", () => {
  const app = makeApp();
  let pool: pg.Pool;

  async function cleanup() {
    await pool.query(`DELETE FROM toters_orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM toters_import_batches WHERE workspace_owner_id = $1`, [
      OWNER_ID,
    ]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  beforeEach(async () => {
    mockRole = "owner";
    await cleanup();
  });

  function upload(path: string, buffer: Buffer, name = "toters.csv") {
    return request(app).post(path).attach("file", buffer, name);
  }

  it("preview reports counts and revenue without writing", async () => {
    const file = csvFile([
      csvRow(),
      csvRow({ Code: "T-2", status: "canceled" }),
      csvRow({ Code: "t-1 " }), // in-file duplicate of T-1 after normalization
      csvRow({ Code: "T-3", "Items Total": "oops" }), // invalid
    ]);
    const res = await upload("/toters-imports/preview", file);
    expect(res.status).toBe(200);
    expect(res.body.total_rows).toBe(4);
    expect(res.body.new_orders).toBe(2);
    expect(res.body.duplicates_in_file).toBe(1);
    expect(res.body.duplicates_existing).toBe(0);
    expect(res.body.invalid_rows).toEqual([{ row: 5, reason: "invalid_items_total" }]);
    expect(res.body.excluded_orders).toBe(1); // the canceled order
    expect(res.body.arrived_orders).toBe(1);
    // 4200 × 1500 / 89700 = 70.2341… → displayed 70.23
    expect(res.body.revenue_to_add).toBe(70.23);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM toters_orders WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(rows[0].n).toBe(0);
  });

  it("imports, then reimporting the same file inserts zero and adds zero revenue", async () => {
    const file = csvFile([csvRow(), csvRow({ Code: "T-2", "Items Total": "100" })]);

    const first = await upload("/toters-imports", file);
    expect(first.status).toBe(200);
    expect(first.body.inserted).toBe(2);
    expect(first.body.skipped_duplicates).toBe(0);
    expect(first.body.revenue_added).toBeCloseTo(71.91, 2); // 70.2341… + 1.6722… → round once

    const again = await upload("/toters-imports", file);
    expect(again.status).toBe(200);
    expect(again.body.inserted).toBe(0);
    expect(again.body.skipped_duplicates).toBe(2);
    expect(again.body.revenue_added).toBe(0);

    // Preview of the same file now reports them as existing duplicates.
    const preview = await upload("/toters-imports/preview", file);
    expect(preview.body.new_orders).toBe(0);
    expect(preview.body.duplicates_existing).toBe(2);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM toters_orders WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(rows[0].n).toBe(2);
  });

  it("overlapping file inserts only new order codes", async () => {
    await upload("/toters-imports", csvFile([csvRow(), csvRow({ Code: "T-2" })]));

    const overlap = await upload(
      "/toters-imports",
      csvFile([csvRow({ Code: "T-2" }), csvRow({ Code: "T-3" }), csvRow({ Code: "T-4" })]),
    );
    expect(overlap.body.inserted).toBe(2);
    expect(overlap.body.skipped_duplicates).toBe(1);

    const { rows } = await pool.query(
      `SELECT external_order_code FROM toters_orders WHERE workspace_owner_id = $1 ORDER BY 1`,
      [OWNER_ID],
    );
    expect(rows.map((r) => r.external_order_code)).toEqual(["T-1", "T-2", "T-3", "T-4"]);
  });

  it("concurrent imports of the same file cannot create duplicates (DB constraint)", async () => {
    const file = csvFile([csvRow(), csvRow({ Code: "T-2" }), csvRow({ Code: "T-3" })]);
    const results = await Promise.all([
      upload("/toters-imports", file),
      upload("/toters-imports", file),
      upload("/toters-imports", file),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    const insertedTotal = results.reduce((s, r) => s + r.body.inserted, 0);
    expect(insertedTotal).toBe(3);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM toters_orders WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    expect(rows[0].n).toBe(3);
  });

  it("rows without a Code dedupe via the content fingerprint", async () => {
    const noCode = csvRow({ Code: "" });
    const first = await upload("/toters-imports", csvFile([noCode]));
    expect(first.body.inserted).toBe(1);

    // Same content again → fingerprint conflict, skipped.
    const again = await upload("/toters-imports", csvFile([noCode]));
    expect(again.body.inserted).toBe(0);
    expect(again.body.skipped_duplicates).toBe(1);

    // Different items total → different fingerprint, inserted.
    const different = await upload(
      "/toters-imports",
      csvFile([csvRow({ Code: "", "Items Total": "999.00" })]),
    );
    expect(different.body.inserted).toBe(1);
  });

  it("stores non-arrived orders but excludes them from revenue", async () => {
    const res = await upload(
      "/toters-imports",
      csvFile([
        csvRow(),
        csvRow({ Code: "T-2", status: "canceled", "Items Total": "5000" }),
        csvRow({ Code: "T-3", status: "declined", "Items Total": "7000" }),
      ]),
    );
    expect(res.body.inserted).toBe(3);
    expect(res.body.excluded_orders).toBe(2);
    expect(res.body.revenue_added).toBe(70.23);

    const { rows } = await pool.query(
      `SELECT status, calculated_revenue FROM toters_orders WHERE workspace_owner_id = $1 ORDER BY external_order_code`,
      [OWNER_ID],
    );
    expect(rows).toHaveLength(3);
    // Full-precision revenue is stored even for excluded orders.
    expect(Number(rows[1].calculated_revenue)).toBeCloseTo(83.61204013, 6);
  });

  it("aggregates the synthesized 394-order validation file to $21,022.60", async () => {
    // Equivalent to the documented real export: 394 arrived orders whose raw
    // Items Total sums to exactly 1,257,151.19.
    const rows = Array.from({ length: 394 }, (_, i) =>
      csvRow({
        Code: `AGG-${i + 1}`,
        "Items Total": i < 393 ? "3190.74" : "3190.37",
      }),
    );
    const res = await upload("/toters-imports", csvFile(rows));
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(394);
    expect(res.body.revenue_added).toBe(21022.6);

    // The DB aggregate of unrounded values rounds once to the same figure.
    const { rows: agg } = await pool.query(
      `SELECT SUM(calculated_revenue) AS revenue FROM toters_orders
        WHERE workspace_owner_id = $1 AND status = 'arrived'`,
      [OWNER_ID],
    );
    expect(Math.round(Number(agg[0].revenue) * 100) / 100).toBe(21022.6);
  });

  it("rejects non-owner members", async () => {
    mockRole = "member";
    const res = await upload("/toters-imports", csvFile([csvRow()]));
    expect(res.status).toBe(403);
    const preview = await upload("/toters-imports/preview", csvFile([csvRow()]));
    expect(preview.status).toBe(403);
  });

  it("rejects files missing required columns", async () => {
    const res = await upload(
      "/toters-imports/preview",
      Buffer.from("Code,status\nT-1,arrived\n", "utf-8"),
    );
    expect(res.status).toBe(400);
    expect(res.body.missing_columns).toEqual(
      expect.arrayContaining(["Client First Name", "Store", "Order Time", "Items Total"]),
    );
  });

  it("lists import history newest first", async () => {
    await upload("/toters-imports", csvFile([csvRow()]), "first.csv");
    await upload("/toters-imports", csvFile([csvRow({ Code: "T-2" })]), "second.csv");

    const res = await request(app).get("/toters-imports");
    expect(res.status).toBe(200);
    expect(res.body.batches).toHaveLength(2);
    expect(res.body.batches[0].file_name).toBe("second.csv");
    expect(res.body.batches[0].inserted).toBe(1);
    expect(res.body.batches[0].revenue_added).toBe(70.23);
    expect(res.body.batches[1].file_name).toBe("first.csv");
  });
});
