import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { z } from "zod/v4";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { buildAdhocInvoiceData } from "../lib/adhocInvoicePdf";
import { buildOrderInvoicePdf } from "../lib/orderInvoicePdf";
import { db } from "../lib/db";
import { objectStorageClient, objectStorageService } from "../lib/objectStorage";

const router = Router();

router.use(requireAuth, resolveWorkspace);

const generateInvoiceSchema = z.object({
  name: z.string().max(200).optional().nullable(),
  email: z.string().max(200).optional().nullable(),
  address: z.string().max(300).optional().nullable(),
  item: z.string().max(500).optional().nullable(),
  amount: z.number().min(0).max(1_000_000_000).optional().nullable(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "Currency must be a 3-letter code")
    .optional()
    .nullable(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function uploadInvoicePdf(
  buffer: Buffer,
  workspaceOwnerId: string,
): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const objectId = randomUUID();
  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/invoices/${objectId}`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType: "application/pdf", resumable: false });
  return `/objects/${workspaceOwnerId}/invoices/${objectId}`;
}

/**
 * Neutralize spreadsheet formula injection by prefixing cells whose value
 * begins with a formula-triggering character with an apostrophe. This prevents
 * Excel / Google Sheets from evaluating the cell as a formula when the CSV is
 * opened. Applied to all user-controlled text fields.
 */
function neutralizeFormula(value: string | null | undefined): string | null {
  if (value == null) return null;
  const str = String(value);
  return /^[=+\-@|%]/.test(str) ? `'${str}` : str;
}

function escapeCSV(value: string | null | undefined): string {
  if (value == null) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCSVRow(cols: Array<string | null | undefined>): string {
  return cols.map(escapeCSV).join(",");
}

// ---------------------------------------------------------------------------
// POST /api/invoices/generate
// ---------------------------------------------------------------------------

/**
 * POST /api/invoices/generate
 * Generate a standalone (ad-hoc) invoice PDF from optional form fields.
 * On success, uploads the PDF to private object storage and inserts a history
 * row into generated_invoices, then streams the PDF back to the caller.
 * A storage/DB failure is logged but does NOT prevent the PDF from being
 * returned (non-blocking persistence).
 */
router.post("/invoices/generate", async (req: Request, res: Response): Promise<void> => {
  const parsed = generateInvoiceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "Invalid input",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  let pdf: Buffer;
  let data: ReturnType<typeof buildAdhocInvoiceData>;

  try {
    data = buildAdhocInvoiceData(parsed.data);
    pdf = await buildOrderInvoicePdf(data);
  } catch (err) {
    req.log.error({ err }, "Failed to generate ad-hoc invoice PDF");
    res.status(500).json({ success: false, error: "Failed to generate invoice" });
    return;
  }

  // Non-blocking: upload PDF to storage and persist history row.
  const wreq = workspace(req);
  (async () => {
    try {
      const objectKey = await uploadInvoicePdf(pdf, wreq.workspaceOwnerId);
      await db.query(
        `INSERT INTO generated_invoices
           (workspace_owner_id, invoice_number, customer_name, customer_email,
            customer_address, item_description, amount, currency,
            created_by_user_id, created_by_name, pdf_object_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (workspace_owner_id, invoice_number)
        DO UPDATE SET pdf_object_key = EXCLUDED.pdf_object_key`,
        [
          wreq.workspaceOwnerId,
          data.invoiceNumber,
          data.billToName ?? null,
          data.billToEmail ?? null,
          data.billToCountry ?? null,
          parsed.data.item?.trim() || null,
          parsed.data.amount ?? null,
          data.currency,
          wreq.userId,
          wreq.userEmail ?? null,
          objectKey,
        ],
      );
    } catch (err) {
      req.log.error({ err }, "Failed to persist generated invoice history (non-blocking)");
    }
  })();

  const safeName = `Invoice-${data.invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.send(pdf);
});

// ---------------------------------------------------------------------------
// GET /api/invoices
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  search: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  currency: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

/**
 * GET /api/invoices
 * List paginated generated invoice history with optional filters and a summary.
 */
router.get("/invoices", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid query parameters" });
    return;
  }
  const { search, dateFrom, dateTo, currency, page, pageSize } = parsed.data;

  const params: unknown[] = [wreq.workspaceOwnerId];
  const conditions: string[] = ["workspace_owner_id = $1"];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(
      `(customer_name ILIKE $${params.length} OR invoice_number ILIKE $${params.length})`,
    );
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`created_at <= $${params.length}::timestamptz`);
  }
  if (currency) {
    params.push(currency.toUpperCase());
    conditions.push(`currency = $${params.length}`);
  }

  const where = conditions.join(" AND ");

  try {
    // Summary aggregation (all filtered rows, no pagination).
    const summaryResult = await db.query<{
      total: string;
      this_month: string;
      total_value: string | null;
      last_created_at: string | null;
    }>(
      `SELECT
         COUNT(*)                                              AS total,
         COUNT(*) FILTER (
           WHERE date_trunc('month', created_at) =
                 date_trunc('month', now())
         )                                                    AS this_month,
         SUM(amount)                                          AS total_value,
         MAX(created_at)                                      AS last_created_at
       FROM generated_invoices
       WHERE ${where}`,
      params,
    );
    const summary = summaryResult.rows[0];

    // Paginated rows.
    const offset = (page - 1) * pageSize;
    const rowsResult = await db.query<{
      id: number;
      invoice_number: string;
      created_at: string;
      customer_name: string | null;
      customer_email: string | null;
      customer_address: string | null;
      item_description: string | null;
      amount: string | null;
      currency: string | null;
      created_by_user_id: string | null;
      created_by_name: string | null;
      pdf_object_key: string | null;
    }>(
      `SELECT id, invoice_number, created_at, customer_name, customer_email,
              customer_address, item_description, amount, currency,
              created_by_user_id, created_by_name, pdf_object_key
         FROM generated_invoices
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );

    res.json({
      success: true,
      items: rowsResult.rows,
      total: Number(summary.total),
      total_pages: Math.ceil(Number(summary.total) / pageSize),
      summary: {
        total: Number(summary.total),
        this_month: Number(summary.this_month),
        total_value: summary.total_value != null ? Number(summary.total_value) : null,
        last_created_at: summary.last_created_at ?? null,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to list generated invoices");
    res.status(500).json({ success: false, error: "Failed to list invoices" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/invoices/export-csv
// ---------------------------------------------------------------------------

/**
 * GET /api/invoices/export-csv
 * Export all filtered generated invoice rows as a CSV file.
 * Accepts the same filter params as GET /invoices (no pagination).
 */
router.get("/invoices/export-csv", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const filterSchema = z.object({
    search: z.string().optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    currency: z.string().optional(),
  });
  const parsed = filterSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid query parameters" });
    return;
  }
  const { search, dateFrom, dateTo, currency } = parsed.data;

  const params: unknown[] = [wreq.workspaceOwnerId];
  const conditions: string[] = ["workspace_owner_id = $1"];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(
      `(customer_name ILIKE $${params.length} OR invoice_number ILIKE $${params.length})`,
    );
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`created_at <= $${params.length}::timestamptz`);
  }
  if (currency) {
    params.push(currency.toUpperCase());
    conditions.push(`currency = $${params.length}`);
  }

  const where = conditions.join(" AND ");

  try {
    const result = await db.query<{
      invoice_number: string;
      created_at: string;
      customer_name: string | null;
      customer_email: string | null;
      customer_address: string | null;
      item_description: string | null;
      amount: string | null;
      currency: string | null;
      created_by_name: string | null;
    }>(
      `SELECT invoice_number, created_at, customer_name, customer_email,
              customer_address, item_description, amount, currency, created_by_name
         FROM generated_invoices
        WHERE ${where}
        ORDER BY created_at DESC`,
      params,
    );

    const header = buildCSVRow([
      "Invoice #",
      "Created",
      "Customer Name",
      "Customer Email",
      "Customer Address",
      "Item Description",
      "Amount",
      "Currency",
      "Created By",
    ]);

    const rows = result.rows.map((r) =>
      buildCSVRow([
        r.invoice_number,
        r.created_at,
        neutralizeFormula(r.customer_name),
        neutralizeFormula(r.customer_email),
        neutralizeFormula(r.customer_address),
        neutralizeFormula(r.item_description),
        r.amount,
        r.currency,
        neutralizeFormula(r.created_by_name),
      ]),
    );

    const csv = [header, ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="invoices.csv"');
    res.send(csv);
  } catch (err) {
    req.log.error({ err }, "Failed to export generated invoices CSV");
    res.status(500).json({ success: false, error: "Failed to export invoices" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/invoices/:id/download
// ---------------------------------------------------------------------------

/**
 * GET /api/invoices/:id/download
 * Re-download the stored PDF for a previously generated invoice history row.
 * Verifies workspace ownership before streaming the stored object.
 */
router.get("/invoices/:id/download", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: "Invalid invoice ID" });
    return;
  }

  try {
    const result = await db.query<{
      invoice_number: string;
      pdf_object_key: string | null;
    }>(
      `SELECT invoice_number, pdf_object_key
         FROM generated_invoices
        WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: "Invoice not found" });
      return;
    }

    const row = result.rows[0];
    if (!row.pdf_object_key) {
      res.status(404).json({ success: false, error: "PDF not available for this invoice" });
      return;
    }

    const file = await objectStorageService.getObjectEntityFile(row.pdf_object_key);
    const safeName = `Invoice-${row.invoice_number.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    file.createReadStream().pipe(res);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ObjectNotFoundError") {
      res.status(404).json({ success: false, error: "PDF not found in storage" });
      return;
    }
    req.log.error({ err }, "Failed to download invoice PDF");
    res.status(500).json({ success: false, error: "Failed to download invoice" });
  }
});

export default router;
