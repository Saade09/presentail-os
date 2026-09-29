/**
 * Toters CSV import — validation preview, confirmed import, batch history.
 *
 * The Toters marketplace exports sales as CSV. This router lets the dashboard
 * upload such a file, preview what would happen (new orders, duplicates,
 * invalid rows, excluded non-arrived orders, revenue to be added), then
 * confirm the import. Inserts use ON CONFLICT DO NOTHING against DB-level
 * unique indexes so concurrent imports can never create duplicates.
 *
 * Paths are registered WITHOUT the /api prefix (the shared router is mounted
 * at /api). Distinct from routes/importToters.ts, which is the API-key
 * Chrome-extension ingest into the general orders table.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  TOTERS_SOURCE,
  TOTERS_REVENUE_STATUS,
  mapTotersHeader,
  parseTotersRows,
  dedupeWithinFile,
  sumRevenueStrings,
  displayRevenue,
  type TotersParsedRow,
} from "../lib/toters";

const router: IRouter = Router();

router.use(requireAuth, resolveWorkspace);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

type UploadedFile = { originalname: string; buffer: Buffer };

/** Parse + validate the uploaded spreadsheet; shared by preview and import. */
async function parseUpload(
  req: Request,
  res: Response,
): Promise<{
  file: UploadedFile;
  parsed: TotersParsedRow[];
  invalid: { row: number; reason: string }[];
  totalRows: number;
} | null> {
  const file = (req as unknown as { file?: UploadedFile }).file;
  if (!file) {
    res.status(400).json({ error: "A file is required" });
    return null;
  }
  const filename = file.originalname.toLowerCase();
  if (!filename.endsWith(".csv") && !filename.endsWith(".xlsx") && !filename.endsWith(".xls")) {
    res.status(400).json({ error: "Only .csv, .xlsx, and .xls files are accepted" });
    return null;
  }

  let rows: unknown[][];
  try {
    const { parseSpreadsheetToRows } = await import("../lib/xlsxHelper.js");
    rows = await parseSpreadsheetToRows(file.buffer, "");
  } catch (err) {
    req.log?.error?.({ err }, "Failed to parse Toters import file");
    res.status(400).json({
      error: "Could not parse the file. Please ensure it is a valid CSV or Excel file.",
    });
    return null;
  }

  if (rows.length < 2) {
    res.status(400).json({ error: "No data rows found in the file." });
    return null;
  }

  const { columns, missing } = mapTotersHeader(rows[0]);
  if (missing.length > 0) {
    res.status(400).json({
      error: `Missing required columns: ${missing.join(", ")}`,
      missing_columns: missing,
    });
    return null;
  }

  const { parsed, invalid } = parseTotersRows(rows, columns);
  const totalRows = parsed.length + invalid.length;
  if (totalRows === 0) {
    res.status(400).json({ error: "No data rows found in the file." });
    return null;
  }
  return { file, parsed, invalid, totalRows };
}

/** Fingerprints of already-imported orders matching the given rows. */
async function findExistingFingerprints(
  ownerId: string,
  rows: readonly TotersParsedRow[],
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const fingerprints = rows.map((r) => r.fingerprint);
  const codes = rows.map((r) => r.code).filter((c): c is string => c !== null);
  const { rows: found } = await db.query<{ dedup_fingerprint: string; external_order_code: string | null }>(
    `SELECT dedup_fingerprint, external_order_code
       FROM toters_orders
      WHERE workspace_owner_id = $1
        AND source = $2
        AND (dedup_fingerprint = ANY($3) OR external_order_code = ANY($4))`,
    [ownerId, TOTERS_SOURCE, fingerprints, codes],
  );
  const existing = new Set<string>();
  const existingCodes = new Set(
    found.map((r) => r.external_order_code).filter((c): c is string => c !== null),
  );
  for (const r of found) existing.add(r.dedup_fingerprint);
  for (const row of rows) {
    if (row.code && existingCodes.has(row.code)) existing.add(row.fingerprint);
  }
  return existing;
}

function summarize(rows: readonly TotersParsedRow[]) {
  const arrived = rows.filter((r) => r.status === TOTERS_REVENUE_STATUS);
  const revenue = sumRevenueStrings(arrived.map((r) => r.calculatedRevenue));
  return {
    arrivedCount: arrived.length,
    excludedCount: rows.length - arrived.length,
    revenue,
    revenueDisplay: displayRevenue(revenue),
  };
}

/**
 * POST /toters-imports/preview
 * Validate an uploaded Toters CSV without writing anything.
 */
router.post("/toters-imports/preview", upload.single("file"), async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can import Toters sales" });
    return;
  }

  const result = await parseUpload(req, res);
  if (!result) return;
  const { file, parsed, invalid, totalRows } = result;

  try {
    const { unique, duplicates: inFileDuplicates } = dedupeWithinFile(parsed);
    const existing = await findExistingFingerprints(wreq.workspaceOwnerId, unique);
    const newRows = unique.filter((r) => !existing.has(r.fingerprint));
    const existingDuplicates = unique.length - newRows.length;
    const summary = summarize(newRows);

    res.json({
      file_name: file.originalname,
      total_rows: totalRows,
      new_orders: newRows.length,
      duplicate_orders: inFileDuplicates.length + existingDuplicates,
      duplicates_in_file: inFileDuplicates.length,
      duplicates_existing: existingDuplicates,
      invalid_rows: invalid,
      excluded_orders: summary.excludedCount,
      arrived_orders: summary.arrivedCount,
      revenue_to_add: summary.revenueDisplay,
    });
  } catch (err) {
    req.log?.error?.({ err }, "Toters import preview failed");
    res.status(500).json({ error: "Failed to validate the file" });
  }
});

/**
 * POST /toters-imports
 * Confirmed import: inserts a batch and its orders. Duplicate orders are
 * skipped by the DB unique indexes (ON CONFLICT DO NOTHING) so reimports and
 * concurrent imports are safe.
 */
router.post("/toters-imports", upload.single("file"), async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can import Toters sales" });
    return;
  }

  const result = await parseUpload(req, res);
  if (!result) return;
  const { file, parsed, invalid, totalRows } = result;

  const { unique, duplicates: inFileDuplicates } = dedupeWithinFile(parsed);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const batchInsert = await client.query<{ id: string }>(
      `INSERT INTO toters_import_batches (workspace_owner_id, file_name, imported_by_user_id, total_rows)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [wreq.workspaceOwnerId, file.originalname, wreq.userId ?? "", totalRows],
    );
    const batchId = batchInsert.rows[0].id;

    // Insert in chunks; ON CONFLICT DO NOTHING (no target) tolerates a
    // violation of either unique index (code or fingerprint) — the DB is the
    // single source of truth for dedup, including across concurrent imports.
    const insertedRows: { status: string; calculated_revenue: string }[] = [];
    const CHUNK = 200;
    for (let offset = 0; offset < unique.length; offset += CHUNK) {
      const chunk = unique.slice(offset, offset + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [wreq.workspaceOwnerId, TOTERS_SOURCE, batchId, wreq.userId ?? ""];
      let p = params.length;
      for (const row of chunk) {
        values.push(
          `($1, $2, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $3, $4)`,
        );
        params.push(
          row.code,
          row.fingerprint,
          row.clientFirstName,
          row.store,
          row.status,
          row.orderTime,
          row.deliveryTime,
          row.arrivedTime,
          row.approvedTime,
          row.markedReadyTime,
          row.itemsTotal,
          row.calculatedRevenue,
        );
      }
      const { rows: returned } = await client.query<{
        status: string;
        calculated_revenue: string;
      }>(
        `INSERT INTO toters_orders (
           workspace_owner_id, source, external_order_code, dedup_fingerprint,
           client_first_name, store, status,
           order_time, delivery_time, arrived_time, approved_time, marked_ready_time,
           items_total, calculated_revenue, batch_id, imported_by_user_id
         )
         VALUES ${values.join(", ")}
         ON CONFLICT DO NOTHING
         RETURNING status, calculated_revenue`,
        params,
      );
      insertedRows.push(...returned);
    }

    const insertedArrived = insertedRows.filter((r) => r.status === TOTERS_REVENUE_STATUS);
    const revenueAdded = sumRevenueStrings(insertedArrived.map((r) => r.calculated_revenue));
    const inserted = insertedRows.length;
    const skippedExisting = unique.length - inserted;
    const duplicateCount = inFileDuplicates.length + skippedExisting;
    const excludedCount = insertedRows.length - insertedArrived.length;

    await client.query(
      `UPDATE toters_import_batches
          SET inserted_count = $2,
              duplicate_count = $3,
              rejected_count = $4,
              excluded_count = $5,
              revenue_added = $6,
              updated_at = now()
        WHERE id = $1`,
      [batchId, inserted, duplicateCount, invalid.length, excludedCount, revenueAdded],
    );

    await client.query("COMMIT");

    res.json({
      batch_id: batchId,
      file_name: file.originalname,
      total_rows: totalRows,
      inserted,
      skipped_duplicates: duplicateCount,
      rejected_rows: invalid,
      excluded_orders: excludedCount,
      revenue_added: displayRevenue(revenueAdded),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log?.error?.({ err }, "Toters import failed");
    res.status(500).json({ error: "Failed to import the file" });
  } finally {
    client.release();
  }
});

/**
 * GET /toters-imports
 * Import history: past batches, newest first.
 */
router.get("/toters-imports", async (req, res) => {
  const wreq = workspace(req);
  try {
    const { rows } = await db.query<{
      id: string;
      file_name: string | null;
      imported_by_user_id: string;
      total_rows: number;
      inserted_count: number;
      duplicate_count: number;
      rejected_count: number;
      excluded_count: number;
      revenue_added: string;
      created_at: string;
    }>(
      `SELECT id, file_name, imported_by_user_id, total_rows, inserted_count,
              duplicate_count, rejected_count, excluded_count, revenue_added, created_at
         FROM toters_import_batches
        WHERE workspace_owner_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [wreq.workspaceOwnerId],
    );
    res.json({
      batches: rows.map((r) => ({
        id: r.id,
        file_name: r.file_name,
        imported_by_user_id: r.imported_by_user_id,
        total_rows: r.total_rows,
        inserted: r.inserted_count,
        skipped_duplicates: r.duplicate_count,
        rejected: r.rejected_count,
        excluded: r.excluded_count,
        revenue_added: displayRevenue(r.revenue_added),
        created_at: new Date(r.created_at).toISOString(),
      })),
    });
  } catch (err) {
    req.log?.error?.({ err }, "Failed to list Toters import batches");
    res.status(500).json({ error: "Failed to load import history" });
  }
});

export default router;
