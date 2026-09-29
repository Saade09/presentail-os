import express, { Router } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import multer from "multer";
import archiver from "archiver";
import { clerkClient } from "@clerk/express";
import { db, withTransaction } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { hasPageAccess, resolveWorkspace, workspace } from "../lib/workspace.js";
import { logger } from "../lib/logger.js";
import { extractInvoiceDataFromBuffer } from "../lib/finance/aiExtraction.js";
import { matchSupplierByName, rankSupplierCandidates } from "../lib/supplierMatcher.js";
import { createConnector } from "../lib/finance/connectorFactory.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { syncImportedSupplierInvoice } from "../lib/finance/syncImportedSupplierInvoice.js";
import { linkImportedInvoiceToVerifiedOdooSupplier } from "../lib/finance/linkImportedInvoiceSupplier.js";
import { recoverMissingInvoiceSupplier } from "../lib/finance/recoverInvoiceSupplier.js";
import { evaluateMultiPageMerge, type MergeInvoiceRow } from "../lib/finance/mergeInvoiceImports.js";
import { reviewSnapshot, validateInvoice } from "../lib/finance/reviewWorkflow.js";
import { encrypt, decryptCredential } from "../lib/credentialEncryption.js";
import { WafeqApiError, WafeqClient, deterministicImportUuid } from "../lib/finance/wafeqClient.js";
import { ensureOdooSupplier } from "../lib/finance/odooConnector.js";
import { OdooJson2Client } from "../lib/finance/odooJson2Client.js";
import type { ExtractedInvoiceData } from "../lib/finance/accountingConnector.js";
import {
  normaliseOdooBaseUrl,
  sanitiseOdooBaseUrlForResponse,
} from "../lib/finance/odooUrl.js";

const objectStorageService = new ObjectStorageService();
const VALID_ACCOUNTING_SYSTEMS = ["odoo", "manual", "none", "wafeq", "quickbooks"] as const;
const VALID_INVOICE_DESTINATIONS = ["odoo", "wafeq", "manual", "none", "undecided"] as const;
type InvoiceDestination = typeof VALID_INVOICE_DESTINATIONS[number];

async function validateOdooDefaultExpenseAccount(values: {
  odoo_base_url: unknown;
  odoo_database: unknown;
  odoo_company_id: unknown;
  odoo_default_expense_account_id: unknown;
}): Promise<string | null> {
  const accountId = Number(values.odoo_default_expense_account_id);
  if (!Number.isInteger(accountId) || accountId <= 0) return "odoo_default_expense_account_id must be a positive integer";
  const base = normaliseOdooBaseUrl(values.odoo_base_url);
  const database = String(values.odoo_database ?? "").trim();
  const companyId = Number(values.odoo_company_id);
  const apiKey = process.env.ODOO_API_KEY?.trim();
  if (!base.ok || !database || !Number.isInteger(companyId) || companyId <= 0 || !apiKey) {
    return "A valid Odoo connection is required to validate the default expense account";
  }
  try {
    const client = new OdooJson2Client({ baseUrl: base.url, database, companyId, apiKey });
    const rows = await client.searchRead<Record<string, unknown>>(
      "account.account",
      [["id", "=", accountId], ["company_ids", "in", [companyId]], ["active", "=", true]],
      ["id", "code", "name", "account_type", "company_ids"],
      2,
    );
    const account = rows.length === 1 ? rows[0] : undefined;
    if (!account || Number(account.id) !== accountId || !String(account.account_type ?? "").startsWith("expense")) {
      return "The default expense account must be an active expense account belonging to the selected Odoo company";
    }
    return null;
  } catch (error) {
    const token = apiKey;
    const message = error instanceof Error ? error.message : "Odoo account validation failed";
    return `Unable to validate the default expense account in Odoo: ${message.split(token).join("[redacted]").replace(/\s+/g, " ").slice(0, 200)}`;
  }
}
type InvoiceRoutingEntity = Pick<FinanceEntityRow, "accounting_system" | "country" | "legal_name" | "display_name">;

const router = Router();

function validMachineAuditSecret(req: express.Request): boolean {
  const configured = process.env.ODOO_API_KEY;
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  if (!configured || !supplied) return false;
  const expected = Buffer.from(
    createHmac("sha256", configured)
      .update("production-odoo-read-only-audit-v1")
      .digest("hex"),
  );
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Machine-only read audit. Register before human Clerk/workspace middleware.
// This route can only reach the connector with readOnly:true.
router.get("/internal/finance/audit-approved-odoo", async (req, res) => {
  if (!validMachineAuditSecret(req)) return void res.status(401).json({ error: "Unauthorized" });
  const entityId = Number(req.query.entity_id);
  if (!Number.isInteger(entityId) || entityId <= 0) return void res.status(400).json({ error: "A valid Odoo finance entity is required" });
  const owner = await db.query<{ workspace_owner_id: string }>(
    `SELECT workspace_owner_id FROM finance_entities WHERE id=$1`,
    [entityId],
  );
  if (!owner.rows[0]) return void res.status(404).json({ error: "Finance entity not found" });
  return auditApprovedToOdooForWorkspace(req, res, owner.rows[0].workspace_owner_id);
});

router.use(requireAuth, resolveWorkspace);

const MAX_PDF_SIZE_BYTES = parseInt(process.env.AI_INVOICE_MAX_PDF_MB ?? "20") * 1024 * 1024;

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_SIZE_BYTES, files: 10 },
  fileFilter(_req, file, cb) {
    const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
    if (SUPPORTED_MIME_TYPES.has(file.mimetype) || SUPPORTED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, JPG, PNG, or WEBP files are allowed"));
    }
  },
});

function invoiceFiles(req: express.Request, res: express.Response, next: express.NextFunction) {
  pdfUpload.array("files", 10)(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return void res.status(413).json({ error: `Invoice files must be ${Math.floor(MAX_PDF_SIZE_BYTES / 1024 / 1024)} MB or smaller` });
    }
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid invoice upload" });
  });
}

function invoiceSourceFile(req: express.Request, res: express.Response, next: express.NextFunction) {
  pdfUpload.single("file")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return void res.status(413).json({ error: `Invoice files must be ${Math.floor(MAX_PDF_SIZE_BYTES / 1024 / 1024)} MB or smaller` });
    }
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid invoice source" });
  });
}

function resolveSupportedMime(file: Pick<Express.Multer.File, "buffer">): string | null {
  const bytes = file.buffer;
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export async function persistInvoiceSource(
  importId: number,
  file: Pick<Express.Multer.File, "originalname" | "buffer">,
  mimeType: string,
  workspaceOwnerId: string,
  options: { expectedVersion?: number; invalidateReview?: boolean } = {},
): Promise<string> {
  const { signedUrl, requiredHeaders } = await objectStorageService.getObjectEntityUploadURL(
    workspaceOwnerId,
    mimeType,
    file.buffer.length,
  );
  const uploadResponse = await fetch(signedUrl, {
    method: "PUT",
    body: new Uint8Array(file.buffer),
    headers: requiredHeaders,
  });
  if (!uploadResponse.ok) throw new Error(`Source storage returned HTTP ${uploadResponse.status}`);
  const storagePath = objectStorageService.normalizeObjectEntityPath(signedUrl);
  const values: unknown[] = [storagePath, file.originalname, mimeType, file.buffer.length, importId];
  let versionGuard = "";
  if (options.expectedVersion !== undefined) {
    values.push(options.expectedVersion);
    versionGuard = ` AND review_version=$${values.length}`;
  }
  const reviewReset = options.invalidateReview
    ? `, review_status='needs_review', approved_at=NULL, approved_by=NULL,
         reviewed_snapshot=NULL, extraction_evidence='{}'::jsonb,
         sync_status='not_requested', review_version=review_version+1`
    : "";
  const updated = await db.query(
    `UPDATE ai_invoice_imports SET pdf_storage_path = $1,
       source_metadata = jsonb_build_object(
         'filename',$2::text,
         'mime_type',$3::text,
         'byte_size',$4::bigint,
         'coordinates_available',false
       ),
       error_message = NULL${reviewReset}, updated_at = now() WHERE id = $5${versionGuard}`,
    values,
  );
  if (!updated.rowCount) throw new Error("Invoice was changed by another reviewer");
  return storagePath;
}

export type FinanceEntityRow = {
  id: number;
  workspace_owner_id: string;
  legal_name: string;
  display_name: string | null;
  country: string | null;
  tax_registration_number: string | null;
  accounting_system: string;
  odoo_company_id: number | null;
  odoo_company_name: string | null;
  odoo_database: string | null;
  odoo_base_url: string | null;
  odoo_integration_token: string | null;
  odoo_default_expense_account_id?: number | null;
  wafeq_api_key?: string | null;
  wafeq_organization_id?: string | null;
  wafeq_supplier_id?: string | null;
  wafeq_account_id?: string | null;
  wafeq_tax_id?: string | null;
  default_currency: string;
  invoice_review_enabled?: boolean;
  is_active: boolean;
  created_at: string;
};

type InvoiceImportRow = {
  id: number;
  workspace_owner_id: string;
  entity_id: number;
  status: string;
  original_filename: string | null;
  pdf_storage_path: string | null;
  vendor_name: string | null;
  vendor_tax_number: string | null;
  vendor_address: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  subtotal: string | null;
  tax_amount: string | null;
  total_amount: string | null;
  line_items: unknown;
  raw_ai_json?: Record<string, unknown> | null;
  confidence: string | null;
  company_validation_status: string | null;
  company_validation_notes: string | null;
  odoo_bill_id: string | null;
  odoo_bill_url: string | null;
  manually_entered_by: string | null;
  manually_entered_at: string | null;
  manual_notes: string | null;
  manual_accounting_reference: string | null;
  error_message: string | null;
  is_reviewed: boolean;
  reviewed_at: string | null;
  reviewed_by: string | null;
  processing_step: string;
  supplier_id: number | null;
  odoo_partner_id?: string | null;
  supplier_name?: string | null;
  supplier_tax_number?: string | null;
  wafeq_supplier_id?: string | null;
  wafeq_account_id?: string | null;
  wafeq_tax_id?: string | null;
  provider_bill_id?: string | null;
  provider_bill_status?: string | null;
  provider_bill_url?: string | null;
  provider_sync_status?: string | null;
  provider_synced_at?: string | null;
  provider_sync_error?: string | null;
  provider_sync_idempotency_key?: string | null;
  billing_country: string | null;
  created_at: string;
  updated_at: string;
  review_status?: string;
  sync_status?: string;
  accounting_destination?: string | null;
  resolved_accounting_destination?: InvoiceDestination | null;
  review_version?: number;
  approved_at?: string | null;
  approved_by?: string | null;
  source_metadata?: Record<string, unknown>;
  extraction_evidence?: Record<string, unknown>;
  source_batch_id?: string | null;
  source_page_number?: number | null;
  source_page_count?: number | null;
  superseded_by_import_id?: number | null;
  superseded_at?: string | null;
  supersede_reason?: string | null;
  reviewed_snapshot?: Record<string, unknown> | null;
  supplier_confirmation?: {
    vendor_name?: string | null;
    candidates?: Array<{
      id: number;
      name: string;
      display_name?: string | null;
      tax_number?: string | null;
      score: number;
    }>;
  } | null;
  invoice_review_enabled?: boolean;
};

type InvoiceSyncOutcome = {
  success: boolean;
  provider_bill_id?: string;
  provider_bill_url?: string;
  provider_bill_status?: string;
  provider_supplier_id?: number;
  provider_supplier_name?: string;
  provider_supplier_tax_number?: string | null;
  outcome?: "created" | "recovered" | "verified_existing" | "repaired_existing" | "eligible_create";
  error?: string;
  reason_code?: string;
  warnings?: string[];
  validation?: unknown;
  supplier_candidates?: Array<{
    id: number;
    name: string;
    display_name?: string | null;
    tax_number?: string | null;
    score: number;
  }>;
  details?: string;
};

function normalizeInvoiceDestination(value: unknown): InvoiceDestination | null | undefined {
  if (value === null || value === undefined || value === "" || value === "automatic") return null;
  if (typeof value === "string" && (VALID_INVOICE_DESTINATIONS as readonly string[]).includes(value)) return value as InvoiceDestination;
  return undefined;
}

export function automaticInvoiceDestination(invoice: Pick<InvoiceImportRow, "billing_country">, entity: InvoiceRoutingEntity): InvoiceDestination | null {
  const entityText = `${entity.legal_name ?? ""} ${entity.display_name ?? ""}`.toLowerCase();
  // The Lebanese legal entity is the authoritative routing signal. The
  // invoice's billing country is a useful fallback, but supplier names and
  // USD currency are deliberately not enough to force a destination.
  if (/^(LB|LEBANON|LEBANESE)$/.test(entity.country?.trim().toUpperCase() ?? "") || /\b(lebanon|lebanese)\b/.test(entityText) || /^(LB|LEBANON|LEBANESE)$/.test(invoice.billing_country?.trim().toUpperCase() ?? "")) {
    return "odoo";
  }
  return (VALID_INVOICE_DESTINATIONS as readonly string[]).includes(entity.accounting_system)
    ? entity.accounting_system as InvoiceDestination
    : null;
}

export function resolvedInvoiceDestination(invoice: Pick<InvoiceImportRow, "accounting_destination" | "billing_country">, entity: InvoiceRoutingEntity): InvoiceDestination | null {
  const explicit = normalizeInvoiceDestination(invoice.accounting_destination);
  return explicit === undefined || explicit === null ? automaticInvoiceDestination(invoice, entity) : explicit;
}

function hasAuthoritativeOdooSyncEvidence(
  invoice: Pick<InvoiceImportRow, "provider_sync_status" | "provider_bill_id" | "provider_bill_status" | "odoo_bill_id">,
  matchingSucceededAttempt = false,
): boolean {
  return invoice.provider_sync_status === "succeeded"
    && !!String(invoice.provider_bill_id ?? "").trim()
    && invoice.provider_bill_id === invoice.odoo_bill_id
    && invoice.provider_bill_status !== "failed"
    && !!String(invoice.odoo_bill_id ?? "").trim()
    && matchingSucceededAttempt;
}

function effectiveInvoiceSyncStatus(invoice: InvoiceImportRow, destination: InvoiceDestination | null, matchingSucceededAttempt = false): string {
  if (destination === "odoo" && !hasAuthoritativeOdooSyncEvidence(invoice, matchingSucceededAttempt)) {
    if (invoice.sync_status === "blocked") return "blocked";
    if (invoice.sync_status === "needs_supplier_confirmation") return "needs_supplier_confirmation";
    if (invoice.sync_status === "failed") return "failed";
    if (invoice.sync_status === "pending" || invoice.sync_status === "in_progress") return invoice.sync_status;
    return "not_requested";
  }
  if (invoice.review_status !== "approved" && invoice.sync_status === "failed") return "not_requested";
  return invoice.sync_status ?? "not_requested";
}

function effectiveInvoiceSyncStatusSql(invoiceAlias = "i", entityAlias = "e"): string {
  const i = invoiceAlias;
  const e = entityAlias;
  const automaticOdoo = `(
    ${i}.accounting_destination = 'odoo'
    OR (${i}.accounting_destination IS NULL AND (
      upper(trim(coalesce(${e}.country,''))) IN ('LB','LEBANON','LEBANESE')
      OR lower(coalesce(${e}.legal_name,'') || ' ' || coalesce(${e}.display_name,'')) ~ '\\m(lebanon|lebanese)\\M'
      OR upper(trim(coalesce(${i}.billing_country,''))) IN ('LB','LEBANON','LEBANESE')
      OR ${e}.accounting_system = 'odoo'
    ))
  )`;
  return `CASE
    WHEN ${i}.sync_status='blocked' THEN 'blocked'
    WHEN ${automaticOdoo} THEN CASE
      WHEN ${i}.provider_sync_status='succeeded'
       AND nullif(${i}.provider_bill_id,'') IS NOT NULL
       AND ${i}.provider_bill_status IS DISTINCT FROM 'failed'
       AND nullif(${i}.odoo_bill_id,'') IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM ai_invoice_import_sync_attempts osa
          WHERE osa.import_id=${i}.id
            AND osa.destination='odoo'
            AND osa.status='succeeded'
            AND osa.verified_at IS NOT NULL
            AND osa.external_reference=${i}.odoo_bill_id
       ) THEN 'succeeded'
       WHEN ${i}.sync_status IN ('pending','in_progress','failed','needs_supplier_confirmation') THEN ${i}.sync_status
      ELSE 'not_requested'
    END
     WHEN ${i}.review_status <> 'approved' AND ${i}.sync_status='failed' THEN 'not_requested'
    ELSE COALESCE(${i}.sync_status,'not_requested')
  END`;
}

function withSourceDocument(importRow: InvoiceImportRow) {
  return {
    ...importRow,
    source_document: {
      available: !!importRow.pdf_storage_path,
      url: importRow.pdf_storage_path
        ? `/api/finance/invoice-review/${importRow.id}/source`
        : null,
    },
    merged_source_pages: importRow.source_batch_id
      ? `/api/finance/invoice-review/${importRow.id}/source-pages`
      : Array.isArray(importRow.source_metadata?.merged_source_documents)
        ? `/api/finance/invoice-review/${importRow.id}/source-pages`
      : null,
  };
}

function isOwner(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceActualRole === "owner";
}

function hasFinanceAccess(wreq: ReturnType<typeof workspace>): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    (wreq.allowedPages?.includes("ai-invoice-import") ?? false) ||
    (wreq.allowedPages?.includes("finance_accounting") ?? false)
  );
}

function canReadFinanceEntities(wreq: ReturnType<typeof workspace>): boolean {
  return hasFinanceAccess(wreq) || hasPageAccess(wreq, "invoice-scanners");
}

function requiredOdooValue(value: unknown, field: string): string | null {
  if (typeof value !== "string" || !value.trim()) return `${field} is required for Odoo`;
  return null;
}

function validateOdooConfiguration(values: {
  odoo_base_url?: unknown;
  odoo_database?: unknown;
  odoo_company_id?: unknown;
  odoo_company_name?: unknown;
  odoo_integration_token?: unknown;
}): string | null {
  for (const [value, field] of [
    [values.odoo_base_url, "odoo_base_url"],
    [values.odoo_database, "odoo_database"],
    [values.odoo_company_name, "odoo_company_name"],
    [values.odoo_integration_token, "odoo_integration_token"],
  ] as const) {
    const error = requiredOdooValue(value, field);
    if (error) return error;
  }

  const companyId = Number(values.odoo_company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return "odoo_company_id must be a positive integer for Odoo";
  }

  const urlResult = normaliseOdooBaseUrl(values.odoo_base_url);
  if (!urlResult.ok) return urlResult.error;

  return null;
}

const ODOO_ENTITY_SETUP_ERROR = "Configure a default Odoo expense account in Entity Settings before syncing invoices";

function entityRequiresOdooSetup(entity: FinanceEntityRow): boolean {
  return entity.odoo_default_expense_account_id === null;
}

function odooEntitySetupResponse(res: express.Response) {
  return res.status(422).json({
    success: false,
    entity_setup_required: true,
    reason_code: "entity_setup_required",
    error: ODOO_ENTITY_SETUP_ERROR,
  });
}

function sanitiseEntityForResponse(entity: FinanceEntityRow) {
  const { odoo_integration_token: _tok, wafeq_api_key: _wafeqKey, ...safe } = entity;
  return {
    ...safe,
    odoo_base_url: sanitiseOdooBaseUrlForResponse(safe.odoo_base_url),
    odoo_integration_configured: !!(_tok),
  };
}

type WafeqConnectionRow = {
  encrypted_api_key: string;
  organization_id: string | null;
  organization_name: string | null;
  status: string;
  last_verified_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
};

function wafeqSafeConnection(row: WafeqConnectionRow | undefined) {
  if (!row) return { configured: false, status: "not_configured" };
  return {
    configured: row.status === "configured",
    status: row.status,
    organization_id: row.organization_id,
    organization_name: row.organization_name,
    last_verified_at: row.last_verified_at,
    last_error: row.last_error,
    last_error_at: row.last_error_at,
  };
}

function wafeqFailureState(error: unknown): { status: "rate_limit" | "invalid" | "unavailable"; message: string; httpStatus: number } {
  if (error instanceof WafeqApiError && error.rateLimited) return { status: "rate_limit", message: "Wafeq rate limit exceeded", httpStatus: 429 };
  if (error instanceof WafeqApiError && (error.status === 401 || error.status === 403)) {
    return { status: "invalid", message: "Wafeq credentials could not be verified", httpStatus: 422 };
  }
  return { status: "unavailable", message: "Wafeq is temporarily unavailable", httpStatus: 503 };
}

function safeWafeqOrganizationName(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return null;
  const names = value as { en?: unknown; ar?: unknown; name?: unknown; name_en?: unknown };
  for (const candidate of [names.en, names.name, names.name_en, names.ar]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

async function readWafeqConnection(workspaceOwnerId: string): Promise<WafeqConnectionRow | undefined> {
  const result = await db.query<WafeqConnectionRow>(
    `SELECT encrypted_api_key,organization_id,organization_name,status,last_verified_at,last_error,last_error_at
       FROM wafeq_connections WHERE workspace_owner_id=$1`,
    [workspaceOwnerId],
  );
  return result.rows[0];
}

async function wafeqClientForWorkspace(workspaceOwnerId: string): Promise<{ row: WafeqConnectionRow; client: WafeqClient } | null> {
  const row = await readWafeqConnection(workspaceOwnerId);
  if (!row?.encrypted_api_key) return null;
  const apiKey = await decryptCredential(row.encrypted_api_key, async (migrated) => {
    await db.query(`UPDATE wafeq_connections SET encrypted_api_key=$1,updated_at=now() WHERE workspace_owner_id=$2`, [migrated, workspaceOwnerId]);
  });
  return { row, client: new WafeqClient({ apiKey }) };
}

async function verifyWafeqKey(apiKey: string) {
  const client = new WafeqClient({ apiKey });
  const organization = await client.verifyOrganization();
  const id = organization.id ?? organization.organization_id;
  if (typeof id !== "string" && typeof id !== "number") throw new WafeqApiError(200, "Wafeq returned an invalid organization");
  const name = organization.name ?? organization.name_en ?? organization.display_name;
  return { client, organizationId: String(id), organizationName: safeWafeqOrganizationName(name) };
}

async function connectWafeq(req: express.Request, res: express.Response) {
  const wreq = workspace(req);
  if (!isOwner(wreq)) return void res.status(403).json({ error: "Owner access required" });
  const value = (req.body as Record<string, unknown>).api_key ?? (req.body as Record<string, unknown>).apiKey;
  if (typeof value !== "string" || !value.trim()) return void res.status(400).json({ error: "api_key is required" });
  let encrypted: string;
  try {
    encrypted = encrypt(value.trim());
  } catch {
    return void res.status(503).json({ error: "Credential encryption is not configured" });
  }
  try {
    const verified = await verifyWafeqKey(value.trim());
    const saved = await db.query<WafeqConnectionRow>(
      `INSERT INTO wafeq_connections(workspace_owner_id,encrypted_api_key,organization_id,organization_name,status,last_verified_at,last_error,last_error_at,updated_at)
         VALUES($1,$2,$3,$4,'configured',now(),NULL,NULL,now())
       ON CONFLICT(workspace_owner_id) DO UPDATE SET encrypted_api_key=EXCLUDED.encrypted_api_key,organization_id=EXCLUDED.organization_id,organization_name=EXCLUDED.organization_name,status='configured',last_verified_at=now(),last_error=NULL,last_error_at=NULL,updated_at=now()
       RETURNING encrypted_api_key,organization_id,organization_name,status,last_verified_at,last_error,last_error_at`,
      [wreq.workspaceOwnerId, encrypted, verified.organizationId, verified.organizationName],
    );
    return void res.json({ connection: wafeqSafeConnection(saved.rows[0]) });
  } catch (error) {
    // Verification must succeed before replacing an active credential. A
    // mistyped or rate-limited candidate key must not destroy the connection
    // the workspace is already using.
    const failure = wafeqFailureState(error);
    return void res.status(failure.httpStatus).json({ connection: { status: failure.status, configured: false }, error: failure.message });
  }
}

async function testWafeqConnection(req: express.Request, res: express.Response) {
  const wreq = workspace(req);
  if (!isOwner(wreq)) return void res.status(403).json({ error: "Owner access required" });
  const supplied = (req.body as Record<string, unknown> | undefined)?.api_key;
  let clientInfo: { row: WafeqConnectionRow; client: WafeqClient } | null = null;
  try {
    if (typeof supplied === "string" && supplied.trim()) {
      const verified = await verifyWafeqKey(supplied.trim());
      return void res.json({ success: true, connection: { configured: true, status: "configured", organization_id: verified.organizationId, organization_name: verified.organizationName } });
    }
    clientInfo = await wafeqClientForWorkspace(wreq.workspaceOwnerId);
    if (!clientInfo) return void res.status(503).json({ connection: { configured: false, status: "not_configured" }, error: "Wafeq connection is not configured" });
    const organization = await clientInfo.client.verifyOrganization();
    await db.query(
      `UPDATE wafeq_connections
          SET status='configured',last_verified_at=now(),last_error=NULL,last_error_at=NULL,updated_at=now()
        WHERE workspace_owner_id=$1`,
      [wreq.workspaceOwnerId],
    );
    return void res.json({ success: true, connection: { configured: true, status: "configured", organization_id: String(organization.id ?? organization.organization_id), organization_name: safeWafeqOrganizationName(organization.name ?? organization.name_en ?? organization.display_name) } });
  } catch (error) {
    const failure = wafeqFailureState(error);
    if (clientInfo) {
      await db.query(
        `UPDATE wafeq_connections
            SET status=$1,last_error=$2,last_error_at=now(),updated_at=now()
          WHERE workspace_owner_id=$3`,
        [failure.status, failure.message, wreq.workspaceOwnerId],
      );
    }
    return void res.status(failure.httpStatus).json({ success: false, connection: { configured: false, status: failure.status }, error: failure.message });
  }
}

router.get(["/finance/wafeq", "/finance/wafeq/connection", "/finance/wafeq-connection"], async (req, res) => {
  if (!isOwner(workspace(req))) return void res.status(403).json({ error: "Owner access required" });
  const row = await readWafeqConnection(workspace(req).workspaceOwnerId);
  res.json({ connection: wafeqSafeConnection(row) });
});
router.post(["/finance/wafeq", "/finance/wafeq/connection", "/finance/wafeq/connect", "/finance/wafeq/connection/replace"], connectWafeq);
router.put(["/finance/wafeq/connection", "/finance/wafeq/connection/replace"], connectWafeq);
router.post(["/finance/wafeq/test", "/finance/wafeq/connection/test", "/finance/wafeq/verify", "/finance/wafeq/connection/verify"], testWafeqConnection);
router.get(["/finance/wafeq/test", "/finance/wafeq/connection/test", "/finance/wafeq/verify", "/finance/wafeq/connection/verify"], testWafeqConnection);
router.delete(["/finance/wafeq", "/finance/wafeq/connection", "/finance/wafeq-connection"], async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) return void res.status(403).json({ error: "Owner access required" });
  await db.query(`DELETE FROM wafeq_connections WHERE workspace_owner_id=$1`, [wreq.workspaceOwnerId]);
  res.json({ success: true });
});

function isActiveLebanonConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505" &&
    "constraint" in error &&
    (error as { constraint?: unknown }).constraint ===
      "finance_entities_one_active_lb_per_workspace"
  );
}

router.get("/finance/entities", async (req, res) => {
  const wreq = workspace(req);
  if (!canReadFinanceEntities(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const result = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE workspace_owner_id = $1 ORDER BY legal_name ASC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ entities: result.rows.map(sanitiseEntityForResponse) });
});

router.post("/finance/entities", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }

  const {
    legal_name,
    display_name,
    country,
    tax_registration_number,
    accounting_system = "none",
    odoo_company_id,
    odoo_company_name,
    odoo_database,
    odoo_base_url,
    odoo_integration_token,
    odoo_default_expense_account_id,
    default_currency = "USD",
    invoice_review_enabled = true,
  } = req.body as Record<string, unknown>;
  const normalisedCountry = country ? String(country).trim().toUpperCase() : null;

  if (!legal_name || typeof legal_name !== "string" || !legal_name.trim()) {
    res.status(400).json({ error: "legal_name is required" });
    return;
  }

  if (typeof accounting_system === "string" && !VALID_ACCOUNTING_SYSTEMS.includes(accounting_system as typeof VALID_ACCOUNTING_SYSTEMS[number])) {
    res.status(400).json({ error: `accounting_system must be one of: ${VALID_ACCOUNTING_SYSTEMS.join(", ")}` });
    return;
  }
  if (String(accounting_system) === "odoo") {
    const odooError = validateOdooConfiguration({
      odoo_base_url,
      odoo_database,
      odoo_company_id,
      odoo_company_name,
      odoo_integration_token,
    });
    if (odooError) {
      res.status(400).json({ error: odooError });
      return;
    }
  }
  if (odoo_default_expense_account_id !== undefined && odoo_default_expense_account_id !== null && odoo_default_expense_account_id !== "") {
    const accountError = await validateOdooDefaultExpenseAccount({
      odoo_base_url,
      odoo_database,
      odoo_company_id,
      odoo_default_expense_account_id,
    });
    if (accountError) {
      res.status(422).json({ error: accountError });
      return;
    }
  }

  if (normalisedCountry === "LB") {
    const activeLebanon = await db.query<{ id: number }>(
      `SELECT id FROM finance_entities
        WHERE workspace_owner_id = $1
          AND country = 'LB'
          AND is_active = true
        ORDER BY updated_at DESC, id DESC
        LIMIT 1`,
      [wreq.workspaceOwnerId],
    );
    if (activeLebanon.rowCount && activeLebanon.rowCount > 0) {
      res.status(409).json({
        error: "An active Lebanon finance entity already exists. Update that entity instead.",
        entity_id: activeLebanon.rows[0].id,
      });
      return;
    }
  }

  const baseUrlResult = odoo_base_url ? normaliseOdooBaseUrl(odoo_base_url) : null;
  const storedOdooBaseUrl = baseUrlResult?.ok
    ? baseUrlResult.url
    : (odoo_base_url ? String(odoo_base_url).trim() : null);

  let result;
  try {
    result = await db.query<FinanceEntityRow>(
      `INSERT INTO finance_entities
         (workspace_owner_id, legal_name, display_name, country, tax_registration_number,
          accounting_system, odoo_company_id, odoo_company_name, odoo_database,
           odoo_base_url, odoo_integration_token, odoo_default_expense_account_id, default_currency, invoice_review_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        String(legal_name).trim(),
        display_name ? String(display_name).trim() : null,
        normalisedCountry,
        tax_registration_number ? String(tax_registration_number).trim() : null,
        String(accounting_system),
        odoo_company_id ? Number(odoo_company_id) : null,
        odoo_company_name ? String(odoo_company_name).trim() : null,
        odoo_database ? String(odoo_database).trim() : null,
        storedOdooBaseUrl,
        odoo_integration_token ? String(odoo_integration_token).trim() : null,
        odoo_default_expense_account_id ? Number(odoo_default_expense_account_id) : null,
        String(default_currency).trim() || "USD",
        invoice_review_enabled === true || invoice_review_enabled === "true",
      ],
    );
  } catch (error) {
    if (isActiveLebanonConflict(error)) {
      res.status(409).json({
        error: "An active Lebanon finance entity already exists. Update that entity instead.",
      });
      return;
    }
    throw error;
  }

  res.status(201).json({ entity: sanitiseEntityForResponse(result.rows[0]) });
});

router.patch("/finance/entities/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid entity id" });
    return;
  }

  const existing = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Entity not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const values: unknown[] = [];

  const appendField = (col: string, val: unknown) => {
    values.push(val);
    fields.push(`${col} = $${values.length}`);
  };

  if ("legal_name" in body) appendField("legal_name", body.legal_name ? String(body.legal_name).trim() : existing.rows[0].legal_name);
  if ("display_name" in body) appendField("display_name", body.display_name ? String(body.display_name).trim() : null);
  if ("country" in body) appendField("country", body.country ? String(body.country).trim().toUpperCase() : null);
  if ("tax_registration_number" in body) appendField("tax_registration_number", body.tax_registration_number ? String(body.tax_registration_number).trim() : null);
  if ("accounting_system" in body) appendField("accounting_system", body.accounting_system ? String(body.accounting_system) : "none");
  if ("odoo_company_id" in body) appendField("odoo_company_id", body.odoo_company_id ? Number(body.odoo_company_id) : null);
  if ("odoo_company_name" in body) appendField("odoo_company_name", body.odoo_company_name ? String(body.odoo_company_name).trim() : null);
  if ("odoo_database" in body) appendField("odoo_database", body.odoo_database ? String(body.odoo_database).trim() : null);
  if ("odoo_base_url" in body) appendField("odoo_base_url", body.odoo_base_url ? String(body.odoo_base_url).trim() : null);
  // An empty token means "keep the existing secret". There is deliberately no
  // UI/API operation here that clears credentials by accident.
  if (typeof body.odoo_integration_token === "string" && body.odoo_integration_token.trim()) {
    appendField("odoo_integration_token", body.odoo_integration_token.trim());
  }
  if ("odoo_default_expense_account_id" in body) {
    appendField("odoo_default_expense_account_id", body.odoo_default_expense_account_id ? Number(body.odoo_default_expense_account_id) : null);
  }
  if ("default_currency" in body) appendField("default_currency", body.default_currency ? String(body.default_currency).trim() : "USD");
  if ("invoice_review_enabled" in body) appendField("invoice_review_enabled", body.invoice_review_enabled === true || body.invoice_review_enabled === "true");
  if ("is_active" in body) appendField("is_active", body.is_active === true || body.is_active === "true");

  if (fields.length === 0) {
    if (
      "odoo_integration_token" in body &&
      typeof body.odoo_integration_token === "string" &&
      !body.odoo_integration_token.trim()
    ) {
      res.json({ entity: sanitiseEntityForResponse(existing.rows[0]) });
      return;
    }
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const current = existing.rows[0];
  const nextAccountingSystem = "accounting_system" in body
    ? String(body.accounting_system || "none")
    : current.accounting_system;
  const nextOdoo = {
    odoo_base_url: "odoo_base_url" in body ? body.odoo_base_url : current.odoo_base_url,
    odoo_database: "odoo_database" in body ? body.odoo_database : current.odoo_database,
    odoo_company_id: "odoo_company_id" in body ? body.odoo_company_id : current.odoo_company_id,
    odoo_company_name: "odoo_company_name" in body ? body.odoo_company_name : current.odoo_company_name,
    odoo_integration_token:
      typeof body.odoo_integration_token === "string" && body.odoo_integration_token.trim()
        ? body.odoo_integration_token
        : current.odoo_integration_token,
  };
  if (!VALID_ACCOUNTING_SYSTEMS.includes(nextAccountingSystem as typeof VALID_ACCOUNTING_SYSTEMS[number])) {
    res.status(400).json({ error: `accounting_system must be one of: ${VALID_ACCOUNTING_SYSTEMS.join(", ")}` });
    return;
  }
  if (nextAccountingSystem === "odoo") {
    const odooError = validateOdooConfiguration(nextOdoo);
    if (odooError) {
      res.status(400).json({ error: odooError });
      return;
    }
  }
  const nextDefaultExpenseAccountId = "odoo_default_expense_account_id" in body
    ? body.odoo_default_expense_account_id
    : current.odoo_default_expense_account_id;
  const odooConnectionChanged = [
    "accounting_system",
    "odoo_base_url",
    "odoo_database",
    "odoo_company_id",
    "odoo_default_expense_account_id",
  ].some((key) => key in body);
  if (
    nextAccountingSystem === "odoo"
    && odooConnectionChanged
    && nextDefaultExpenseAccountId !== null
    && nextDefaultExpenseAccountId !== ""
    && nextDefaultExpenseAccountId !== undefined
  ) {
    const accountError = await validateOdooDefaultExpenseAccount({
      odoo_base_url: nextOdoo.odoo_base_url,
      odoo_database: nextOdoo.odoo_database,
      odoo_company_id: nextOdoo.odoo_company_id,
      odoo_default_expense_account_id: nextDefaultExpenseAccountId,
    });
    if (accountError) {
      res.status(422).json({ error: accountError });
      return;
    }
  }

  values.push(id, wreq.workspaceOwnerId);
  let result;
  try {
    result = await db.query<FinanceEntityRow>(
      `UPDATE finance_entities SET ${fields.join(", ")}, updated_at = now()
       WHERE id = $${values.length - 1} AND workspace_owner_id = $${values.length}
       RETURNING *`,
      values,
    );
  } catch (error) {
    if (isActiveLebanonConflict(error)) {
      res.status(409).json({
        error: "Another active Lebanon finance entity already exists.",
      });
      return;
    }
    throw error;
  }

  res.json({ entity: sanitiseEntityForResponse(result.rows[0]) });
});

router.delete("/finance/entities/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid entity id" });
    return;
  }

  const result = await db.query(
    `UPDATE finance_entities SET is_active = false, updated_at = now()
     WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Entity not found" });
    return;
  }

  res.json({ success: true });
});

router.get("/finance/ai-invoice-import", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const entityId = req.query.entity_id ? parseInt(String(req.query.entity_id), 10) : null;
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
  const offset = parseInt(String(req.query.offset ?? "0"), 10);

  const conditions: string[] = ["i.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (entityId && !isNaN(entityId)) {
    params.push(entityId);
    conditions.push(`i.entity_id = $${params.length}`);
  }

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ai_invoice_imports i WHERE ${conditions.join(" AND ")}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  params.push(limit, offset);
  const result = await db.query<InvoiceImportRow & { entity_legal_name: string; entity_accounting_system: string; supplier_name: string | null }>(
    `SELECT i.*,
            fe.legal_name AS entity_legal_name,
            fe.accounting_system AS entity_accounting_system,
            fe.invoice_review_enabled,
            COALESCE(s.display_name, s.name) AS supplier_name
       FROM ai_invoice_imports i
       LEFT JOIN finance_entities fe ON fe.id = i.entity_id
       LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY i.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  res.json({ imports: result.rows.map(withSourceDocument), total, limit, offset });
});

router.get("/finance/ai-invoice-import/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const result = await db.query<InvoiceImportRow & { entity_legal_name: string; entity_accounting_system: string; supplier_name: string | null }>(
    `SELECT i.*,
            fe.legal_name AS entity_legal_name,
            fe.accounting_system AS entity_accounting_system,
            COALESCE(s.display_name, s.name) AS supplier_name
       FROM ai_invoice_imports i
       LEFT JOIN finance_entities fe ON fe.id = i.entity_id
       LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.id = $1 AND i.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  res.json({ import: withSourceDocument(result.rows[0]) });
});

router.post("/finance/ai-invoice-import/upload", invoiceFiles, async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const entityId = parseInt(String(req.body?.entity_id ?? ""), 10);
  if (isNaN(entityId)) {
    res.status(400).json({ error: "entity_id is required" });
    return;
  }

  const entityResult = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE id = $1 AND workspace_owner_id = $2 AND is_active = true`,
    [entityId, wreq.workspaceOwnerId],
  );
  if (entityResult.rowCount === 0) {
    res.status(404).json({ error: "Entity not found or inactive" });
    return;
  }

  const entity = entityResult.rows[0];
  const files = req.files as Express.Multer.File[] | undefined;

  if (!files || files.length === 0) {
    res.status(400).json({ error: "No supported files uploaded (PDF, JPG, PNG, WEBP)" });
    return;
  }

  const importIds: number[] = [];
  const failures: Array<{ filename: string; import_id?: number; error: string; retryable: boolean }> = [];
  const sourceBatchId = typeof req.body?.source_batch_id === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(req.body.source_batch_id)
    ? req.body.source_batch_id
    : randomUUID();

  for (const file of files) {
    const resolvedMime = resolveSupportedMime(file);
    if (!resolvedMime) {
      failures.push({ filename: file.originalname, error: "File content is not a valid PDF, JPG, PNG, or WEBP document", retryable: false });
      continue;
    }

    const insertResult = await db.query<{ id: number }>(
       `INSERT INTO ai_invoice_imports
          (workspace_owner_id, entity_id, status, original_filename, source_metadata,
           source_batch_id, source_page_number, source_page_count)
        VALUES ($1, $2, 'uploaded', $3, $4, $5, $6, $7)
       RETURNING id`,
       [wreq.workspaceOwnerId, entityId, file.originalname, JSON.stringify({ filename: file.originalname, mime_type: resolvedMime, byte_size: file.buffer.length, coordinates_available: false }), sourceBatchId, importIds.length + failures.length + 1, files.length],
    );
    const importId = insertResult.rows[0].id;
    await auditReview(importId, wreq.userId, "uploaded", { mime_type: resolvedMime, byte_size: file.buffer.length });

    try {
      await persistInvoiceSource(importId, file, resolvedMime, wreq.workspaceOwnerId);
      importIds.push(importId);
      await auditReview(importId, wreq.userId, "source_stored", { mime_type: resolvedMime, byte_size: file.buffer.length });
    } catch (error) {
      logger.warn({ err: error, importId }, "finance: required source upload failed");
      await db.query(
        `UPDATE ai_invoice_imports SET status='failed', processing_step='source_storage_failed',
           error_message='Source document storage failed. Retry or replace the attachment.', updated_at=now()
         WHERE id=$1`,
        [importId],
      );
      await auditReview(importId, wreq.userId, "source_storage_failed");
      failures.push({ filename: file.originalname, import_id: importId, error: "Source document storage failed", retryable: true });
      // Keep extraction useful even when source storage is temporarily down.
      // This preserves the invoice record and lets the source be replaced later.
      void processInvoiceAsync(importId, { buffer: file.buffer, mimeType: resolvedMime }, entity, wreq.workspaceOwnerId).catch((err) => {
        logger.error({ err, importId }, "finance: invoice extraction after source failure failed");
      });
      continue;
    }

    void processInvoiceAsync(importId, { buffer: file.buffer, mimeType: resolvedMime }, entity, wreq.workspaceOwnerId, true).catch((err) => {
      logger.error({ err, importId }, "finance: async invoice processing failed");
    });
  }

  res.status(202).json({
    import_ids: importIds,
    failures,
    message: failures.length ? "Some source documents could not be stored" : "Upload accepted, processing started",
  });
});

export async function processInvoiceAsync(
  importId: number,
  file: { buffer: Buffer; mimeType: string },
  entity: FinanceEntityRow,
  workspaceOwnerId: string,
  sourceAlreadyStored = false,
): Promise<void> {
  try {
    await db.query(
      `UPDATE ai_invoice_imports SET status = 'processing', processing_step = 'converting', updated_at = now() WHERE id = $1`,
      [importId],
    );

    let storagePath: string | null = null;
    if (sourceAlreadyStored) {
      const stored = await db.query<{ pdf_storage_path: string | null }>(
        `SELECT pdf_storage_path FROM ai_invoice_imports WHERE id=$1 AND workspace_owner_id=$2`,
        [importId, workspaceOwnerId],
      );
      storagePath = stored.rows[0]?.pdf_storage_path ?? null;
      if (!storagePath) throw new Error("Required source document is missing");
    } else {
      // Scanner and historical internal callers retain their established
      // best-effort behavior. The interactive upload route passes
      // sourceAlreadyStored=true and never accepts a review upload without it.
      try {
        storagePath = await persistInvoiceSource(importId, { originalname: `invoice-${importId}`, buffer: file.buffer }, file.mimeType, workspaceOwnerId);
      } catch (storageErr) {
        logger.warn({ err: storageErr, importId }, "finance: source storage failed for legacy processing");
      }
    }

    await db.query(
      `UPDATE ai_invoice_imports SET processing_step = 'reading', updated_at = now() WHERE id = $1`,
      [importId],
    );
    const extracted = await extractInvoiceDataFromBuffer(
      file.buffer,
      file.mimeType,
      entity.legal_name,
      entity.tax_registration_number,
      { workspaceOwnerId },
    );

    await db.query(
      `UPDATE ai_invoice_imports SET processing_step = 'extracting', updated_at = now() WHERE id = $1`,
      [importId],
    );
    await db.query(
      `UPDATE ai_invoice_imports SET extraction_evidence=$1 WHERE id=$2`,
      [JSON.stringify({
        provider: "ai_invoice_extraction",
        source_values: { total_amount: extracted.total_amount },
        ...(extracted.extraction_evidence ?? { coordinates_available: false, fields: {}, lines: [] }),
      }), importId],
    );
    await auditReview(importId, undefined, "extracted", { confidence: extracted.confidence, coordinates_available: extracted.extraction_evidence?.coordinates_available ?? false });

    // Auto-match vendor name against existing workspace suppliers.
    // Score >= 90 → silent auto-link, status stays 'extracted'.
    // No match → needs_review so user resolves the supplier.
    // NOTE: company_validation_status is still stored for audit, but it
    // no longer drives the needs_review flag (wrong concept — it was
    // comparing vendor name against buyer entity, not against suppliers).
    let newStatus = "extracted";
    let matchedSupplierId: number | null = null;

    if (extracted.vendor_name) {
      try {
        const suppliersResult = await db.query<{ id: number; name: string; display_name: string | null }>(
          `SELECT id, name, display_name FROM suppliers WHERE workspace_owner_id = $1 AND is_archived = false`,
          [workspaceOwnerId],
        );
        const match = matchSupplierByName(extracted.vendor_name, suppliersResult.rows);
        if (match) {
          matchedSupplierId = match.id;
        } else {
          newStatus = "needs_review";
        }
      } catch (matchErr) {
        logger.warn({ err: matchErr, importId }, "finance: supplier auto-match failed, defaulting to needs_review");
        newStatus = "needs_review";
      }
    } else {
      // No vendor name extracted — can't match; prompt user to review.
      newStatus = "needs_review";
    }

    await db.query(
      `UPDATE ai_invoice_imports SET
         vendor_name = $1,
         vendor_tax_number = $2,
         vendor_address = $3,
         invoice_number = $4,
         invoice_date = $5,
         due_date = $6,
         currency = $7,
         subtotal = $8,
         tax_amount = $9,
         total_amount = $10,
         line_items = $11,
         confidence = $12,
         company_validation_status = $13,
         company_validation_notes = $14,
         raw_ai_json = $15,
         status = $16,
         supplier_id = $17,
         billing_country = $18,
         updated_at = now()
       WHERE id = $19`,
      [
        extracted.vendor_name,
        extracted.vendor_tax_number,
        extracted.vendor_address,
        extracted.invoice_number,
        extracted.invoice_date,
        extracted.due_date,
        extracted.currency,
        extracted.subtotal,
        extracted.tax_amount,
        extracted.total_amount,
        JSON.stringify(extracted.line_items),
        extracted.confidence,
        extracted.company_validation_status,
        extracted.company_validation_notes,
        JSON.stringify(extracted.raw_ai_json),
        newStatus,
        matchedSupplierId,
        extracted.billing_country ?? null,
        importId,
      ],
    );
    await syncImportedSupplierInvoice(importId, workspaceOwnerId);

    // Extraction never posts to accounting. A reviewer must explicitly approve
    // the canonical snapshot before the idempotent sync attempt is created.
  } catch (err) {
    logger.error({ err, importId }, "finance: invoice processing pipeline failed");
    await db.query(
      `UPDATE ai_invoice_imports SET
         status = 'failed',
         error_message = $1,
         updated_at = now()
       WHERE id = $2`,
      [err instanceof Error ? err.message : "Processing failed", importId],
    ).catch(() => {});
    await syncImportedSupplierInvoice(importId, workspaceOwnerId).catch(() => {});
  }
}

router.get("/finance/ai-invoice-import/settings", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const entityId = parseInt(String(req.query.entity_id ?? ""), 10);
  if (isNaN(entityId)) {
    res.status(400).json({ error: "entity_id is required" });
    return;
  }

  const entityCheck = await db.query(
    `SELECT id FROM finance_entities WHERE id = $1 AND workspace_owner_id = $2`,
    [entityId, wreq.workspaceOwnerId],
  );
  if (entityCheck.rowCount === 0) {
    res.status(404).json({ error: "Entity not found" });
    return;
  }

  const result = await db.query<{ id: number; entity_id: number; settings_json: unknown; created_at: string; updated_at: string }>(
    `SELECT * FROM ai_invoice_import_settings WHERE entity_id = $1 AND workspace_owner_id = $2`,
    [entityId, wreq.workspaceOwnerId],
  );

  const defaults = {
    confidence_threshold_auto: 0.85,
    confidence_threshold_review: 0.60,
    auto_create_vendor: false,
    auto_post_vendor_bill: false,
    export_format: "csv",
    odoo_journal_id: null,
    odoo_account_id: null,
  };

  if (result.rowCount === 0) {
    res.json({ settings: defaults, entity_id: entityId });
    return;
  }

  const row = result.rows[0];
  const stored = (row.settings_json as Record<string, unknown>) ?? {};
  res.json({ settings: { ...defaults, ...stored, auto_post_vendor_bill: false }, entity_id: entityId });
});

router.post("/finance/ai-invoice-import/settings", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Owner access required to update settings" });
    return;
  }

  const entityId = parseInt(String(req.query.entity_id ?? ""), 10);
  if (isNaN(entityId)) {
    res.status(400).json({ error: "entity_id is required" });
    return;
  }

  const entityCheck = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE id = $1 AND workspace_owner_id = $2`,
    [entityId, wreq.workspaceOwnerId],
  );
  if (entityCheck.rowCount === 0) {
    res.status(404).json({ error: "Entity not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const safeSettings = {
    ...body,
    auto_post_vendor_bill: false,
  };

  await db.query(
    `INSERT INTO ai_invoice_import_settings (workspace_owner_id, entity_id, settings_json)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_owner_id, entity_id)
     DO UPDATE SET settings_json = $3, updated_at = now()`,
    [wreq.workspaceOwnerId, entityId, JSON.stringify(safeSettings)],
  );

  if (entityCheck.rows[0].accounting_system === "odoo") {
    const connector = createConnector(entityCheck.rows[0]);
    connector.syncSettings(entityId, safeSettings).catch((err) => {
      logger.warn({ err, entityId }, "finance: Odoo settings sync failed (non-fatal)");
    });
  }

  res.json({ success: true, settings: safeSettings });
});

router.get("/finance/ai-invoice-import/imports/:id/supplier-suggestions", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const importResult = await db.query<{ vendor_name: string | null }>(
    `SELECT vendor_name FROM ai_invoice_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (importResult.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const vendorName = importResult.rows[0].vendor_name;
  if (!vendorName) {
    res.json({ suggestions: [] });
    return;
  }

  const suppliersResult = await db.query<{ id: number; name: string; display_name: string | null }>(
    `SELECT id, name, display_name FROM suppliers WHERE workspace_owner_id = $1 AND is_archived = false`,
    [wreq.workspaceOwnerId],
  );

  const suggestions = rankSupplierCandidates(vendorName, suppliersResult.rows);
  res.json({ suggestions, vendor_name: vendorName });
});

router.post("/finance/ai-invoice-import/imports/:id/confirm", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const result = await db.query(
    `UPDATE ai_invoice_imports SET
       status = 'manually_entered',
       is_reviewed = true,
       reviewed_at = now(),
       reviewed_by = $1,
       updated_at = now()
     WHERE id = $2 AND workspace_owner_id = $3
     RETURNING id`,
    [wreq.userId, id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  try {
    await syncImportedSupplierInvoice(id, wreq.workspaceOwnerId);
  } catch (error) {
    logger.error({ err: error, importId: id }, "finance: supplier invoice mirror failed after confirmation");
    res.status(503).json({ success: false, error: "Invoice was confirmed, but the supplier ledger is temporarily unavailable. Please retry." });
    return;
  }
  res.json({ success: true });
});

router.post("/finance/ai-invoice-import/imports/:id/mark-manually-entered", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const { manual_notes, manual_accounting_reference } = req.body as Record<string, unknown>;

  const result = await db.query(
    `UPDATE ai_invoice_imports SET
       status = 'manually_entered',
       manually_entered_by = $1,
       manually_entered_at = now(),
       manual_notes = $2,
       manual_accounting_reference = $3,
       updated_at = now()
     WHERE id = $4 AND workspace_owner_id = $5
     RETURNING id`,
    [
      wreq.userId,
      manual_notes ? String(manual_notes).trim() : null,
      manual_accounting_reference ? String(manual_accounting_reference).trim() : null,
      id,
      wreq.workspaceOwnerId,
    ],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  try {
    await syncImportedSupplierInvoice(id, wreq.workspaceOwnerId);
  } catch (error) {
    logger.error({ err: error, importId: id }, "finance: supplier invoice mirror failed after manual entry");
    res.status(503).json({ success: false, error: "Invoice was marked manually entered, but the supplier ledger is temporarily unavailable. Please retry." });
    return;
  }
  res.json({ success: true });
});

router.get("/finance/ai-invoice-import/imports/:id/export.csv", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const result = await db.query<InvoiceImportRow>(
    `SELECT * FROM ai_invoice_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const row = result.rows[0];
  const lineItems = Array.isArray(row.line_items) ? row.line_items as Array<Record<string, unknown>> : [];

  const csvLines = [
    "Description,Quantity,Unit Price,Total,Tax Rate,Account Code,Product Code",
    ...lineItems.map((li) =>
      [
        `"${String(li.description ?? "").replace(/"/g, '""')}"`,
        li.quantity ?? "",
        li.unit_price ?? "",
        li.total ?? "",
        li.tax_rate ?? "",
        li.account_code ?? "",
        li.product_code ?? "",
      ].join(","),
    ),
  ];

  const csv = csvLines.join("\n");
  const filename = `invoice-${row.invoice_number ?? id}-${row.entity_id}.csv`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

router.get("/finance/ai-invoice-import/imports/:id/export.json", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const result = await db.query<InvoiceImportRow>(
    `SELECT * FROM ai_invoice_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const row = result.rows[0];
  const exportData = {
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    due_date: row.due_date,
    vendor_name: row.vendor_name,
    vendor_tax_number: row.vendor_tax_number,
    vendor_address: row.vendor_address,
    currency: row.currency,
    subtotal: row.subtotal,
    tax_amount: row.tax_amount,
    total_amount: row.total_amount,
    line_items: row.line_items,
    confidence: row.confidence,
    status: row.status,
    imported_at: row.created_at,
  };

  const filename = `invoice-${row.invoice_number ?? id}.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.json(exportData);
});

router.get("/finance/ai-invoice-import/imports/:id/download-pdf-bundle", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const result = await db.query<InvoiceImportRow>(
    `SELECT * FROM ai_invoice_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const row = result.rows[0];
  const archive = archiver("zip", { zlib: { level: 6 } });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="invoice-bundle-${id}.zip"`);

  archive.pipe(res);

  const lineItems = Array.isArray(row.line_items) ? row.line_items as Array<Record<string, unknown>> : [];
  const csvLines = [
    "Description,Quantity,Unit Price,Total,Tax Rate",
    ...lineItems.map((li) =>
      [
        `"${String(li.description ?? "").replace(/"/g, '""')}"`,
        li.quantity ?? "",
        li.unit_price ?? "",
        li.total ?? "",
        li.tax_rate ?? "",
      ].join(","),
    ),
  ];
  archive.append(csvLines.join("\n"), { name: `invoice-${id}.csv` });

  const exportData = {
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    vendor_name: row.vendor_name,
    currency: row.currency,
    total_amount: row.total_amount,
    line_items: row.line_items,
  };
  archive.append(JSON.stringify(exportData, null, 2), { name: `invoice-${id}.json` });

  archive.finalize().catch((err: unknown) => {
    logger.error({ err, id }, "finance: archive finalize error");
  });
});

router.post("/finance/ai-invoice-import/imports/:id/send-to-odoo", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const importResult = await db.query<InvoiceImportRow>(
    `SELECT * FROM ai_invoice_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (importResult.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const importRow = importResult.rows[0];

  const entityResult = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE id = $1 AND workspace_owner_id = $2`,
    [importRow.entity_id, wreq.workspaceOwnerId],
  );

  if (entityResult.rowCount === 0) {
    res.status(404).json({ error: "Finance entity not found" });
    return;
  }

  const entity = entityResult.rows[0];

  if (entity.accounting_system !== "odoo") {
    res.status(400).json({ error: "This entity does not use Odoo" });
    return;
  }

  if (!entity.odoo_base_url || !entity.odoo_database || !entity.odoo_company_id || !process.env.ODOO_API_KEY) {
    res.status(400).json({ error: "Odoo credentials are not configured on this entity" });
    return;
  }

  const invoice = { ...importRow, review_version: importRow.review_version ?? 1 };

  const lockResult = await db.query(
    `UPDATE ai_invoice_imports SET status = 'processing', error_message = NULL, updated_at = now() WHERE id = $1 AND (status != 'processing' OR updated_at < now() - interval '5 minutes')`,
    [id],
  );

  if ((lockResult.rowCount ?? 0) === 0) {
    res.status(409).json({ error: "This import is already being processed" });
    return;
  }

  const attempt = await claimInvoiceSyncAttempt(invoice, "odoo", wreq.workspaceOwnerId, {
    idempotencyKey: `manual-odoo:${id}:${invoice.review_version}:${randomUUID()}`,
    requireApproved: false,
    lockAlreadyHeld: true,
    startInProgress: true,
  });
  if (!attempt) {
    return void res.status(409).json({ error: "This import is already being processed" });
  }
  const billResult = await ensureInvoiceInOdoo(
    invoice,
    entity,
    {
      attemptId: attempt.attemptId,
      leaseToken: attempt.leaseToken,
      workspaceOwnerId: wreq.workspaceOwnerId,
      actorId: wreq.userId,
      allowMissingPersistence: true,
      skipValidation: true,
    },
  );

  // Keep the legacy status fields in step with the canonical provider result
  // for scanner/import consumers that have not migrated to review sync_status.
  const awaitingSupplier = billResult.reason_code === "supplier_confirmation_required";
  await db.query(
    `UPDATE ai_invoice_imports SET status=$1 /* sent_to_odoo or failed; needs_supplier_confirmation is a paused state */,error_message=$2,updated_at=now() WHERE id=$3 AND workspace_owner_id=$4`,
    [billResult.success ? "sent_to_odoo" : awaitingSupplier ? "needs_review" : "failed", awaitingSupplier ? null : billResult.success ? null : billResult.error ?? "Odoo returned an error", id, wreq.workspaceOwnerId],
  );
  if (awaitingSupplier) {
    return void res.json({
      success: false,
      needs_supplier_confirmation: true,
      supplier_candidates: billResult.supplier_candidates ?? [],
    });
  }
  if (!billResult.success) {
    return void res.status(syncFailureStatus(billResult.error)).json({ success: false, error: billResult.error ?? "Odoo returned an error" });
  }
  res.json({
    success: true,
    bill_id: billResult.provider_bill_id,
    bill_url: billResult.provider_bill_url,
    outcome: billResult.outcome ?? "created",
  });
});

router.patch("/finance/ai-invoice-import/imports/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const existing = await db.query<InvoiceImportRow>(
    `SELECT * FROM ai_invoice_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;

  const ALLOWED_STRING_FIELDS = [
    "vendor_name",
    "vendor_tax_number",
    "vendor_address",
    "invoice_number",
    "invoice_date",
    "due_date",
    "currency",
  ] as const;

  const ALLOWED_NUMERIC_FIELDS = ["subtotal", "tax_amount", "total_amount"] as const;

  const fields: string[] = [];
  const values: unknown[] = [];

  const appendField = (col: string, val: unknown) => {
    values.push(val);
    fields.push(`${col} = $${values.length}`);
  };

  for (const col of ALLOWED_STRING_FIELDS) {
    if (col in body) {
      const v = body[col];
      appendField(col, v != null && String(v).trim() !== "" ? String(v).trim() : null);
    }
  }

  for (const col of ALLOWED_NUMERIC_FIELDS) {
    if (col in body) {
      const v = body[col];
      const parsed = v != null ? parseFloat(String(v)) : NaN;
      appendField(col, isNaN(parsed) ? null : parsed);
    }
  }

  if ("line_items" in body) {
    const li = body.line_items;
    appendField("line_items", Array.isArray(li) ? JSON.stringify(li) : "[]");
  }

  // supplier_id can be patched to link/unlink a supplier (null = unlink).
  if ("supplier_id" in body) {
    const sid = body.supplier_id;
    if (sid === null || sid === undefined) {
      appendField("supplier_id", null);
    } else {
      const parsed = parseInt(String(sid), 10);
      if (!isNaN(parsed)) {
        // Verify the supplier belongs to this workspace before linking.
        const supplierCheck = await db.query<{ id: number }>(
          `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false`,
          [parsed, wreq.workspaceOwnerId],
        );
        if (supplierCheck.rowCount === 0) {
          res.status(404).json({ error: "Supplier not found" });
          return;
        }
        appendField("supplier_id", parsed);
      }
    }
  }

  if (fields.length === 0) {
    res.status(400).json({ error: "No valid fields provided" });
    return;
  }

  const changedFields = [
    ...ALLOWED_STRING_FIELDS.filter((col) => col in body),
    ...ALLOWED_NUMERIC_FIELDS.filter((col) => col in body),
    ...(["supplier_id", "wafeq_supplier_id", "wafeq_account_id", "wafeq_tax_id"] as const).filter((col) => col in body),
    ...("line_items" in body ? ["line_items" as const] : []),
  ];
  const existingRow = existing.rows[0];
  const beforeSnapshot: Record<string, unknown> = {};
  const afterSnapshot: Record<string, unknown> = {};
  for (const col of changedFields) {
    beforeSnapshot[col] = (existingRow as Record<string, unknown>)[col] ?? null;
  }

  appendField("is_reviewed", true);
  appendField("reviewed_at", new Date().toISOString());
  appendField("reviewed_by", wreq.userId);

  values.push(id, wreq.workspaceOwnerId);
  const result = await db.query<InvoiceImportRow>(
    `UPDATE ai_invoice_imports
        SET ${fields.join(", ")}, updated_at = now()
      WHERE id = $${values.length - 1} AND workspace_owner_id = $${values.length}
      RETURNING *`,
    values,
  );

  const updatedRow = result.rows[0];
  for (const col of changedFields) {
    afterSnapshot[col] = (updatedRow as Record<string, unknown>)[col] ?? null;
  }

  if (Object.keys(beforeSnapshot).length > 0) {
    await db.query(
      `INSERT INTO ai_invoice_import_edits (import_id, changed_by, before_values, after_values)
       VALUES ($1, $2, $3, $4)`,
      [id, wreq.userId, JSON.stringify(beforeSnapshot), JSON.stringify(afterSnapshot)],
    );
  }

  await syncImportedSupplierInvoice(id, wreq.workspaceOwnerId);
  res.json({ import: updatedRow });
});

router.get("/finance/ai-invoice-import/imports/:id/edits", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccess(wreq)) {
    res.status(403).json({ error: "Finance access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const importCheck = await db.query(
    `SELECT id FROM ai_invoice_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (importCheck.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  const editsResult = await db.query<{
    id: number;
    import_id: number;
    changed_by: string;
    changed_at: string;
    before_values: Record<string, unknown>;
    after_values: Record<string, unknown>;
  }>(
    `SELECT id, import_id, changed_by, changed_at, before_values, after_values
       FROM ai_invoice_import_edits
      WHERE import_id = $1
      ORDER BY changed_at DESC`,
    [id],
  );

  const edits = editsResult.rows;
  const changerIds = [...new Set(edits.map((e) => e.changed_by))];
  const nameMap: Record<string, string> = {};
  if (changerIds.length > 0) {
    try {
      const clerkUsers = await clerkClient.users.getUserList({ userId: changerIds, limit: 100 });
      for (const u of clerkUsers.data) {
        nameMap[u.id] =
          [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
          u.emailAddresses[0]?.emailAddress ||
          u.id;
      }
    } catch (err) {
      logger.warn({ err }, "Could not resolve clerk names for invoice edit history");
    }
  }

  res.json({
    edits: edits.map((e) => ({
      ...e,
      changed_by_name: nameMap[e.changed_by] ?? e.changed_by,
    })),
  });
});

// Explicit review API. The full review workspace is the standard invoice flow;
// the historical entity flag is retained only for response compatibility.
async function reviewImport(req: express.Request, res: express.Response, id: number): Promise<InvoiceImportRow | null> {
  const wreq = workspace(req);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid invoice id" });
    return null;
  }
  let currentId = id;
  const visited = new Set<number>();
  for (let depth = 0; depth < 12; depth += 1) {
    if (visited.has(currentId)) {
      res.status(409).json({ error: "Invoice merge chain is invalid" });
      return null;
    }
    visited.add(currentId);
    const result = await db.query<InvoiceImportRow>(
      `SELECT i.* FROM ai_invoice_imports i JOIN finance_entities e ON e.id=i.entity_id
        WHERE i.id=$1 AND i.workspace_owner_id=$2`,
      [currentId, wreq.workspaceOwnerId],
    );
    const row = result.rows[0];
    if (!row) {
      res.status(currentId === id ? 404 : 409).json({
        error: currentId === id ? "Review invoice not found" : "Canonical invoice is unavailable",
      });
      return null;
    }
    if (!row.superseded_by_import_id) return row;
    if (row.superseded_by_import_id === row.id) {
      res.status(409).json({ error: "Invoice merge chain is invalid" });
      return null;
    }
    currentId = row.superseded_by_import_id;
  }
  res.status(409).json({ error: "Invoice merge chain is too deep" });
  return null;
}
async function sourceImport(req: express.Request, res: express.Response, id: number): Promise<InvoiceImportRow | null> {
  const wreq = workspace(req);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid invoice id" });
    return null;
  }
  const result = await db.query<InvoiceImportRow>(
    `SELECT * FROM ai_invoice_imports WHERE id=$1 AND workspace_owner_id=$2`,
    [id, wreq.workspaceOwnerId],
  );
  if (!result.rowCount) {
    res.status(404).json({ error: "Source document is unavailable" });
    return null;
  }
  return result.rows[0];
}
function reviewCanEdit(wreq: ReturnType<typeof workspace>) {
  return isOwner(wreq)
    || (wreq.allowedPages?.includes("finance_manager") ?? false)
    || reviewCanAccess(wreq);
}
function reviewCanAccess(wreq: ReturnType<typeof workspace>) {
  return hasPageAccess(wreq, "ai-invoice-import");
}
function reviewCanApprove(wreq: ReturnType<typeof workspace>) { return reviewCanAccess(wreq); }
function reviewCanUploadSource(wreq: ReturnType<typeof workspace>) { return hasFinanceAccess(wreq) || reviewCanEdit(wreq); }
function validVersion(body: Record<string, unknown>) {
  const value = Number(body.version);
  return Number.isInteger(value) && value > 0 ? value : null;
}

type ApprovalOnlyResult =
  | {
      ok: true;
      invoice: InvoiceImportRow;
      validation: Awaited<ReturnType<typeof validateReviewInvoice>>;
      provider: InvoiceDestination | null;
    }
  | {
      ok: false;
      status: 404 | 409 | 422 | 503;
      body: Record<string, unknown>;
    };

/**
 * Approves an invoice without claiming or starting a provider sync.
 *
 * The review workspace's approval route intentionally keeps its existing
 * approve-and-sync behavior. Queue actions use this same validation,
 * source-safety, Odoo-safety, version, audit, and persistence path with sync
 * deferred so approval remains separate from Bulk Sync.
 */
async function approveInvoiceOnly(
  invoice: InvoiceImportRow,
  wreq: ReturnType<typeof workspace>,
  version: number | null,
): Promise<ApprovalOnlyResult> {
  if (version !== invoice.review_version) {
    return { ok: false, status: 409, body: { error: "Invoice was changed by another reviewer" } };
  }
  if (invoice.review_status !== "needs_review" || !["not_requested", "failed"].includes(invoice.sync_status ?? "not_requested")) {
    return { ok: false, status: 409, body: { error: "Only an unsynced invoice awaiting review can be approved" } };
  }
  // Validate the caller's optimistic version before any merge can advance it.
  // A merge may select a different canonical source row and increment that
  // row's version, so all subsequent lifecycle/source checks must use the
  // returned canonical record rather than the stale request row.
  const mergedInvoice = await mergeInvoicePagesIfSafe(invoice, wreq.workspaceOwnerId);
  if (mergedInvoice.superseded_by_import_id) {
    return { ok: false, status: 409, body: { error: "Invoice was superseded by a merged canonical invoice" } };
  }
  invoice = mergedInvoice;
  if (invoice.review_status !== "needs_review" || !["not_requested", "failed"].includes(invoice.sync_status ?? "not_requested")) {
    return { ok: false, status: 409, body: { error: "The canonical invoice changed before approval" } };
  }
  try {
    if (!invoice.pdf_storage_path) throw new Error("missing source path");
    const sourceFile = await objectStorageService.getObjectEntityFile(invoice.pdf_storage_path);
    if (typeof sourceFile.exists === "function") {
      const [exists] = await sourceFile.exists();
      if (!exists) throw new Error("missing source object");
    }
  } catch {
    return {
      ok: false,
      status: 422,
      body: { error: "The authenticated source document is unavailable. Restore it before approval." },
    };
  }
  const entityPreview = await db.query<InvoiceRoutingEntity>(
    `SELECT accounting_system,country,legal_name,display_name FROM finance_entities /* SELECT accounting_system FROM finance_entities */ WHERE id=$1 AND workspace_owner_id=$2`,
    [invoice.entity_id, wreq.workspaceOwnerId],
  );
  const provider = entityPreview.rows[0] ? resolvedInvoiceDestination(invoice, entityPreview.rows[0]) : null;
  if (provider === "wafeq") {
    const connection = await readWafeqConnection(wreq.workspaceOwnerId);
    if (!connection || connection.status !== "configured" || !connection.encrypted_api_key) {
      return {
        ok: false,
        status: 503,
        body: { error: "Wafeq connection is required before approval", state: "not_configured" },
      };
    }
  }
  const safety = provider === "odoo"
    ? await validateOdooSyncSafety(invoice, wreq.workspaceOwnerId)
    : null;
  const effectiveInvoice = safety?.invoice ?? invoice;
  const effectiveVersion = effectiveInvoice.review_version ?? version;
  const validation = safety?.validation
    ?? await validateReviewInvoice(effectiveInvoice, wreq.workspaceOwnerId, provider ?? undefined);
  if (validation.issues.some((issue) => issue.blocking)) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "Resolve all blocking validation issues before approval",
        validation,
      },
    };
  }
  const update = await db.query<InvoiceImportRow>(
    `UPDATE ai_invoice_imports
       SET review_status='approved',approved_at=now(),approved_by=$1,reviewed_snapshot=$2,
           sync_status='not_requested',review_version=review_version+1,updated_at=now()
     WHERE id=$3 AND review_version=$4 AND review_status='needs_review' AND sync_status IN ('not_requested','failed')
     RETURNING *`,
    [wreq.userId, JSON.stringify(reviewSnapshot(effectiveInvoice)), effectiveInvoice.id, effectiveVersion],
  );
  if (!update.rowCount) {
    return { ok: false, status: 409, body: { error: "Invoice was changed by another reviewer" } };
  }
  await auditReview(effectiveInvoice.id, wreq.userId, "approved", {
    version: effectiveVersion + 1,
    unresolved_validation_issues: validation.issues.map((issue) => ({
      issue_key: issue.issue_key,
      severity: issue.severity,
      blocking: issue.blocking,
    })),
  });
  const entityResult = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE id=$1 AND workspace_owner_id=$2`,
    [invoice.entity_id, wreq.workspaceOwnerId],
  );
  if (!entityResult.rows[0]) {
    return { ok: false, status: 404, body: { error: "Finance entity not found" } };
  }
  return {
    ok: true,
    invoice: { ...update.rows[0], resolved_accounting_destination: provider },
    validation,
    provider,
  };
}
function syncFailureStatus(error: string | undefined): 502 | 503 {
  return error?.toLowerCase().includes("configuration unavailable") ? 503 : 502;
}
async function auditReview(importId: number, actorId: string | undefined, event: string, details: Record<string, unknown> = {}) {
  // Details only ever contain identifiers/status/counts, never invoice document content.
  await db.query(`INSERT INTO ai_invoice_import_audit_events(import_id,actor_id,event_type,details) VALUES($1,$2,$3,$4)`,
    [importId, actorId ?? null, event, JSON.stringify(details)]);
}

const MULTI_PAGE_MERGE_POLICY_VERSION = 2;

async function mergeInvoicePagesIfSafe(invoice: InvoiceImportRow, workspaceOwnerId: string): Promise<InvoiceImportRow> {
  if (!invoice.invoice_number) return invoice;
  if (invoice.superseded_by_import_id) {
    const current = await db.query<InvoiceImportRow>(
      `SELECT * FROM ai_invoice_imports WHERE id=$1 AND workspace_owner_id=$2`,
      [invoice.id, workspaceOwnerId],
    );
    return current.rows[0] ?? invoice;
  }
  const client = await db.connect();
  let resultInvoice = invoice;
  try {
    await withTransaction(client, async () => {
      const locked = await client.query<InvoiceImportRow & MergeInvoiceRow>(
        `SELECT i.*,s.odoo_partner_id AS supplier_odoo_partner_id,
                trusted.trusted_supplier_matches
           FROM ai_invoice_imports i
           LEFT JOIN suppliers s ON s.id=i.supplier_id AND s.workspace_owner_id=i.workspace_owner_id
           LEFT JOIN LATERAL (
             SELECT coalesce(
                      jsonb_agg(DISTINCT jsonb_build_object(
                        'supplier_id',hs.id,
                        'odoo_partner_id',hs.odoo_partner_id
                      )),
                      '[]'::jsonb
                    ) AS trusted_supplier_matches
               FROM ai_invoice_imports hi
               JOIN suppliers hs
                 ON hs.id=hi.supplier_id
                AND hs.workspace_owner_id=hi.workspace_owner_id
                AND hs.is_archived=false
                AND hs.odoo_partner_id IS NOT NULL
              WHERE hi.workspace_owner_id=i.workspace_owner_id
                AND hi.entity_id=i.entity_id
                AND hi.id<>i.id
                AND EXISTS (
                  SELECT 1
                    FROM ai_invoice_import_sync_attempts ha
                   WHERE ha.import_id=hi.id
                     AND ha.destination='odoo'
                     AND ha.status='succeeded'
                     AND ha.verified_at IS NOT NULL
                     AND ha.external_reference=hi.odoo_bill_id
                     AND hi.provider_bill_id=hi.odoo_bill_id
                )
                AND (
                  (
                    nullif(regexp_replace(upper(coalesce(i.vendor_name,'')),'[^A-Z0-9]','','g'),'') IS NOT NULL
                    AND nullif(regexp_replace(upper(coalesce(hi.vendor_name,'')),'[^A-Z0-9]','','g'),'') IS NOT NULL
                    AND regexp_replace(upper(coalesce(hi.vendor_name,'')),'[^A-Z0-9]','','g')
                      =regexp_replace(upper(coalesce(i.vendor_name,'')),'[^A-Z0-9]','','g')
                  )
                  OR (
                    nullif(regexp_replace(upper(coalesce(i.vendor_name,'')),'[^A-Z0-9]','','g'),'') IS NOT NULL
                    AND nullif(regexp_replace(upper(coalesce(hs.name,'')),'[^A-Z0-9]','','g'),'') IS NOT NULL
                    AND regexp_replace(upper(coalesce(hs.name,'')),'[^A-Z0-9]','','g')
                      =regexp_replace(upper(coalesce(i.vendor_name,'')),'[^A-Z0-9]','','g')
                  )
                )
           ) trusted ON true
          WHERE i.workspace_owner_id=$1 AND i.entity_id=$2
              AND upper(regexp_replace(trim(invoice_number),'\\s+',' ','g'))
                    =upper(regexp_replace(trim($3),'\\s+',' ','g'))
              AND upper(trim(coalesce(currency,'')))=upper(trim(coalesce($4,'')))
             AND i.superseded_by_import_id IS NULL
           FOR UPDATE OF i`,
        [workspaceOwnerId, invoice.entity_id, invoice.invoice_number, invoice.currency],
      );
      if (locked.rows.length < 2) {
        const requested = await client.query<InvoiceImportRow>(
          `SELECT * FROM ai_invoice_imports WHERE id=$1 AND workspace_owner_id=$2 FOR UPDATE`,
          [invoice.id, workspaceOwnerId],
        );
        resultInvoice = requested.rows[0] ?? locked.rows[0] ?? invoice;
        return;
      }
      const decision = evaluateMultiPageMerge(locked.rows as MergeInvoiceRow[]);
      if (decision.status !== "merged") {
        const evaluationMetadata = JSON.stringify({
          status: decision.status,
          reason: decision.reason,
          policy_version: MULTI_PAGE_MERGE_POLICY_VERSION,
        });
        if (decision.status === "review_required") {
          const transitioned = await client.query<{ id: number }>(
            `UPDATE ai_invoice_imports
                SET sync_status='blocked',provider_sync_status='failed',
                    provider_sync_error=$1,error_message=$1,
                    source_metadata=coalesce(source_metadata,'{}'::jsonb)
                      || jsonb_build_object('multi_page_merge_evaluation',
                           $4::jsonb || jsonb_build_object('review_version',review_version)),
                    updated_at=now()
              WHERE id=ANY($2::int[]) AND workspace_owner_id=$3
                AND superseded_by_import_id IS NULL
                 AND (
                   (source_metadata #>> '{multi_page_merge_evaluation,review_version}')
                     IS DISTINCT FROM review_version::text
                   OR (source_metadata #>> '{multi_page_merge_evaluation,policy_version}')
                     IS DISTINCT FROM $5::text
                 )
              RETURNING id`,
            [decision.reason, locked.rows.map((row) => row.id), workspaceOwnerId, evaluationMetadata, MULTI_PAGE_MERGE_POLICY_VERSION],
          );
          for (const row of transitioned.rows) {
            await client.query(
              `INSERT INTO ai_invoice_import_audit_events(import_id,actor_id,event_type,details)
               VALUES($1,NULL,'multi_page_review_required',$2::jsonb)`,
              [row.id, JSON.stringify({
                source_batch_id: invoice.source_batch_id,
                source_ids: locked.rows.map((candidate) => candidate.id),
              })],
            );
          }
        } else {
          await client.query(
            `UPDATE ai_invoice_imports
                SET source_metadata=coalesce(source_metadata,'{}'::jsonb)
                      || jsonb_build_object('multi_page_merge_evaluation',
                           $1::jsonb || jsonb_build_object('review_version',review_version)),
                    updated_at=now()
              WHERE id=ANY($2::int[]) AND workspace_owner_id=$3
                AND superseded_by_import_id IS NULL
                 AND (
                   (source_metadata #>> '{multi_page_merge_evaluation,review_version}')
                     IS DISTINCT FROM review_version::text
                   OR (source_metadata #>> '{multi_page_merge_evaluation,policy_version}')
                     IS DISTINCT FROM $4::text
                 )`,
            [evaluationMetadata, locked.rows.map((row) => row.id), workspaceOwnerId, MULTI_PAGE_MERGE_POLICY_VERSION],
          );
        }
        resultInvoice = locked.rows.find((row) => row.id === invoice.id) ?? invoice;
        return;
      }
      const canonical = locked.rows.find((row) => row.id === decision.canonicalId) ?? invoice;
      if (locked.rows.some((row) => row.superseded_by_import_id
        || [row.provider_bill_id, row.odoo_bill_id].some((value) => {
          const reference = String(value ?? "").trim();
          return !!reference && reference !== "no-accounting-destination";
        })
        || row.provider_sync_status === "succeeded"
        || row.sync_status === "succeeded")) {
        throw new Error("Multi-page invoice changed during merge; review required");
      }
      const reviewed = reviewSnapshot({
        ...canonical,
         supplier_id: decision.supplierId ?? canonical.supplier_id,
        subtotal: decision.subtotal,
        tax_amount: decision.taxAmount,
        total_amount: decision.totalAmount,
        line_items: decision.lineItems,
      });
       const mergedSourceMetadata = {
          multi_page_merge_policy_version: MULTI_PAGE_MERGE_POLICY_VERSION,
         merged_source_ids: locked.rows.map((source) => source.id),
         merged_source_documents: locked.rows.map((source) => ({
          import_id: source.id,
          path: source.pdf_storage_path ?? null,
          filename: source.original_filename ?? null,
          source_metadata: source.source_metadata ?? null,
           extraction_evidence: source.extraction_evidence ?? null,
           raw_ai_json: source.raw_ai_json ?? null,
        })),
      };
      const canonicalUpdate = await client.query(
        `UPDATE ai_invoice_imports
            SET line_items=$1,subtotal=$2,tax_amount=$3,total_amount=$4,
                supplier_id=coalesce(supplier_id,$10),
                source_metadata=coalesce(source_metadata,'{}'::jsonb) || $6::jsonb,
                reviewed_snapshot=$5::jsonb,review_version=review_version+1,
                sync_status=CASE WHEN sync_status IN ('blocked','failed','superseded') THEN 'not_requested' ELSE sync_status END,
                provider_sync_status=CASE WHEN provider_sync_status='succeeded' THEN provider_sync_status ELSE 'pending' END,
                provider_sync_error=NULL,error_message=NULL,updated_at=now()
            WHERE id=$7 AND workspace_owner_id=$8
             AND review_version=$9
             AND superseded_by_import_id IS NULL
           RETURNING *`,
          [JSON.stringify(decision.lineItems), decision.subtotal, decision.taxAmount, decision.totalAmount, JSON.stringify(reviewed), JSON.stringify(mergedSourceMetadata), canonical.id, workspaceOwnerId, canonical.review_version, decision.supplierId],
      );
      if (canonicalUpdate.rowCount !== 1) {
        throw new Error("Multi-page invoice canonical record changed during merge; review required");
      }
      await client.query(
        `UPDATE ai_invoice_import_issues
            SET resolved_at=now(),resolved_by=NULL,updated_at=now()
          WHERE import_id=$1
            AND (issue_key IN ('duplicate.risk','multi_page_review_required') OR issue_key LIKE 'duplicate.%')
            AND resolved_at IS NULL`,
        [canonical.id],
      );
      const supersededUpdates = await Promise.all(decision.supersededIds.map((id) => {
        const source = locked.rows.find((row) => row.id === id);
        return client.query(
          `UPDATE ai_invoice_imports
              SET status='merged',review_status='superseded',sync_status='superseded',
                  superseded_by_import_id=$1,superseded_at=now(),
                  supersede_reason='multi_page_invoice_merge',updated_at=now()
            WHERE id=$2 AND workspace_owner_id=$3 AND review_version=$4
              AND superseded_by_import_id IS NULL`,
          [canonical.id, id, workspaceOwnerId, source?.review_version],
        );
      }));
      if (supersededUpdates.some((update) => update.rowCount !== 1)) {
        throw new Error("Multi-page invoice source records changed during merge; review required");
      }
      const mergedIds = [canonical.id, ...decision.supersededIds];
      for (const id of mergedIds) {
        await client.query(
          `INSERT INTO ai_invoice_import_audit_events(import_id,actor_id,event_type,details)
           VALUES($1,NULL,$2,$3::jsonb)`,
           [id, id === canonical.id ? "multi_page_merged" : "multi_page_superseded", JSON.stringify({
             canonical_id: canonical.id,
             source_batch_id: invoice.source_batch_id,
             final_page_id: decision.finalPageId,
              source_ids: locked.rows.map((source) => source.id),
              source_paths: locked.rows.map((source) => ({
               import_id: source.id,
               path: source.pdf_storage_path ?? null,
               filename: source.original_filename ?? null,
             })),
           })],
        );
      }
       resultInvoice = canonicalUpdate.rows[0] ?? {
         ...canonical,
         supplier_id: decision.supplierId ?? canonical.supplier_id,
         line_items: decision.lineItems,
         subtotal: decision.subtotal,
         tax_amount: decision.taxAmount,
         total_amount: decision.totalAmount,
         review_version: (canonical.review_version ?? 0) + 1,
       };
    });
  } finally {
    client.release();
  }
  return resultInvoice;
}

/**
 * Queue-facing self-heal. Historical imports did not carry page metadata, so
 * discover merge candidates from the stable business key before applying the
 * existing fail-closed evidence checks.
 */
async function mergeInvoiceGroupsIfSafe(
  workspaceOwnerId: string,
  options: { entityId?: number; seedIds?: number[]; maxGroups?: number } = {},
): Promise<{ groups: number; canonicalizedIds: Record<string, number> }> {
  const canonicalizedIds: Record<string, number> = {};
  try {
    const values: unknown[] = [workspaceOwnerId];
    const entityFilter = Number.isInteger(options.entityId) && (options.entityId as number) > 0
      ? `AND i.entity_id=$${values.push(options.entityId as number)}`
      : "";
    const seedIds = [...new Set((options.seedIds ?? []).filter((id) => Number.isInteger(id) && id > 0))];
    const seedFilter = seedIds.length
      ? `AND bool_or(i.id=ANY($${values.push(seedIds)}::int[]))`
      : "";
    const maxGroups = Math.min(100, Math.max(1, Number(options.maxGroups) || 100));
    const policyVersion = `$${values.push(MULTI_PAGE_MERGE_POLICY_VERSION)}`;
    const limitClause = `LIMIT $${values.push(maxGroups)}`;
    const candidates = await db.query<MergeInvoiceRow>(
    `/* historical_merge_discovery */
     WITH duplicate_keys AS (
       SELECT i.entity_id,
              upper(regexp_replace(trim(i.invoice_number), '\\s+', ' ', 'g')) AS normalized_invoice_number,
              upper(trim(i.currency)) AS normalized_currency
         FROM ai_invoice_imports i
        WHERE i.workspace_owner_id=$1
          ${entityFilter}
          AND i.superseded_by_import_id IS NULL
          AND nullif(trim(i.invoice_number),'') IS NOT NULL
          AND nullif(trim(i.currency),'') IS NOT NULL
        GROUP BY i.entity_id,
                 upper(regexp_replace(trim(i.invoice_number), '\\s+', ' ', 'g')),
                 upper(trim(i.currency))
       HAVING count(*) > 1
          AND bool_or(
            (i.source_metadata #>> '{multi_page_merge_evaluation,review_version}')
              IS DISTINCT FROM i.review_version::text
             OR (i.source_metadata #>> '{multi_page_merge_evaluation,policy_version}')
               IS DISTINCT FROM ${policyVersion}::text
          )
          ${seedFilter}
        ORDER BY min(i.id)
        ${limitClause}
     )
     SELECT i.*,s.odoo_partner_id AS supplier_odoo_partner_id
       FROM ai_invoice_imports i
       JOIN duplicate_keys d
         ON d.entity_id=i.entity_id
        AND d.normalized_invoice_number=upper(regexp_replace(trim(i.invoice_number), '\\s+', ' ', 'g'))
        AND d.normalized_currency=upper(trim(i.currency))
       LEFT JOIN suppliers s ON s.id=i.supplier_id AND s.workspace_owner_id=i.workspace_owner_id
      WHERE i.workspace_owner_id=$1
        AND i.superseded_by_import_id IS NULL
      ORDER BY i.entity_id,upper(trim(i.invoice_number)),upper(trim(i.currency)),i.id`,
      values,
    );
    const groups = new Map<string, MergeInvoiceRow[]>();
    for (const row of candidates.rows ?? []) {
      const key = `${row.entity_id}|${String(row.invoice_number).trim().toUpperCase().replace(/\s+/g, " ")}|${String(row.currency).trim().toUpperCase()}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      try {
        await mergeInvoicePagesIfSafe(rows[0] as InvoiceImportRow, workspaceOwnerId);
        const persisted = await db.query<Pick<InvoiceImportRow, "id" | "superseded_by_import_id">>(
          `SELECT id,superseded_by_import_id
             FROM ai_invoice_imports
            WHERE workspace_owner_id=$1 AND id=ANY($2::int[])`,
          [workspaceOwnerId, rows.map((row) => row.id)],
        );
        for (const row of persisted.rows) {
          if (row.superseded_by_import_id && row.superseded_by_import_id !== row.id) {
            canonicalizedIds[String(row.id)] = row.superseded_by_import_id;
          }
        }
      } catch (error) {
        logger.warn({ err: error, importId: rows[0].id }, "finance: historical invoice merge self-heal skipped");
      }
    }
    return { groups: groups.size, canonicalizedIds };
  } catch (error) {
    logger.warn({ err: error, workspaceOwnerId }, "finance: historical invoice merge discovery skipped");
    return { groups: 0, canonicalizedIds };
  }
}

async function validateReviewInvoice(invoice: InvoiceImportRow, workspaceOwnerId: string, provider?: string) {
  invoice = await mergeInvoicePagesIfSafe(invoice, workspaceOwnerId);
  const wafeqSupplierId = String(invoice.wafeq_supplier_id ?? "").trim();
  const duplicateLookups: Promise<{ rowCount?: number | null }>[] = [];
  if (invoice.invoice_number && invoice.supplier_id) {
    duplicateLookups.push(db.query(
      `SELECT 1 FROM ai_invoice_imports
         WHERE workspace_owner_id=$1 AND entity_id=$2 AND supplier_id=$3
            AND invoice_number=$4 AND id != $5
            AND superseded_by_import_id IS NULL LIMIT 1`,
      [workspaceOwnerId, invoice.entity_id, invoice.supplier_id, invoice.invoice_number, invoice.id],
    ));
  }
  if (invoice.invoice_number && provider === "odoo") {
    duplicateLookups.push(db.query(
      `SELECT 1 FROM ai_invoice_imports
         WHERE workspace_owner_id=$1 AND entity_id=$2
           AND upper(trim(invoice_number))=upper(trim($3))
           AND invoice_date IS NOT DISTINCT FROM $4
           AND upper(coalesce(currency,''))=upper(coalesce($5,''))
            AND id != $6 AND superseded_by_import_id IS NULL
         LIMIT 1`,
      [workspaceOwnerId, invoice.entity_id, invoice.invoice_number, invoice.invoice_date, invoice.currency, invoice.id],
    ));
  }
  // Wafeq's supplier mapping is authoritative whenever present. Run this
  // lookup even when a local supplier was also selected, so dual-mapped
  // imports cannot evade duplicate detection through local-ID precedence.
  if (invoice.invoice_number && provider === "wafeq" && wafeqSupplierId) {
    duplicateLookups.push(db.query(
      `SELECT 1 FROM ai_invoice_imports
         WHERE workspace_owner_id=$1 AND entity_id=$2
            AND wafeq_supplier_id=$3 AND invoice_number=$4 AND id != $5
            AND superseded_by_import_id IS NULL LIMIT 1`,
      [workspaceOwnerId, invoice.entity_id, wafeqSupplierId, invoice.invoice_number, invoice.id],
    ));
  }
  const [settingsResult, ...duplicateResults] = await Promise.all([
    db.query<{ settings_json: Record<string, unknown> }>(`SELECT settings_json FROM ai_invoice_import_settings WHERE entity_id=$1 AND workspace_owner_id=$2`, [invoice.entity_id, workspaceOwnerId]),
    ...duplicateLookups,
  ]);
  const settings = settingsResult.rows[0]?.settings_json ?? {};
  const tolerance = Number(settings.total_line_tolerance ?? settings.reconciliation_tolerance ?? .01);
  const taxRates = Array.isArray(settings.supported_tax_rates) ? settings.supported_tax_rates.map(Number).filter(Number.isFinite) : undefined;
  const wafeqTaxRates = provider === "wafeq" ? await workspaceWafeqTaxRates(workspaceOwnerId) : undefined;
  const effectiveTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : .01;
  const validation = validateInvoice(invoice, effectiveTolerance, { duplicate: duplicateResults.some((result) => !!result.rowCount), supportedTaxRates: taxRates, provider: provider ?? "undecided", wafeqTaxRates });
  const reconciliation = sourceTotalReconciliation(invoice, effectiveTolerance);
  if (reconciliation.status === "mismatch") {
    validation.issues.push({
      issue_key: "source.total_mismatch",
      severity: "error",
      message: `Invoice total differs from the extracted source by ${Math.abs(reconciliation.difference ?? 0).toFixed(2)}`,
      field: "total_amount",
      blocking: true,
    });
  }
  return { ...validation, reconciliation };
}

export type SourceTotalReconciliation = {
  status: "match" | "mismatch" | "pending";
  source_total: number | null;
  calculated_total: number | null;
  difference: number | null;
  tolerance: number;
};

export function sourceTotalReconciliation(
  invoice: Pick<InvoiceImportRow, "total_amount" | "extraction_evidence">,
  tolerance = 0.01,
): SourceTotalReconciliation {
  const sourceValues = invoice.extraction_evidence && typeof invoice.extraction_evidence === "object"
    ? (invoice.extraction_evidence.source_values as Record<string, unknown> | undefined)
    : undefined;
  const normalizedEvidenceValue = String(sourceValues?.total_amount ?? "").replace(/[^0-9.-]/g, "");
  const sourceTotal = normalizedEvidenceValue === "" ? Number.NaN : Number(normalizedEvidenceValue);
  const calculatedTotal = Number(invoice.total_amount);
  const safeTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0.01;
  if (!Number.isFinite(sourceTotal) || !Number.isFinite(calculatedTotal)) {
    return { status: "pending", source_total: Number.isFinite(sourceTotal) ? sourceTotal : null, calculated_total: Number.isFinite(calculatedTotal) ? calculatedTotal : null, difference: null, tolerance: safeTolerance };
  }
  const difference = Math.round((calculatedTotal - sourceTotal) * 10000) / 10000;
  return {
    status: Math.abs(difference) <= safeTolerance ? "match" : "mismatch",
    source_total: sourceTotal,
    calculated_total: calculatedTotal,
    difference,
    tolerance: safeTolerance,
  };
}
async function workspaceWafeqTaxRates(workspaceOwnerId: string): Promise<Array<{ id?: string | number; external_id?: string | number; rate?: string | number | null }>> {
  try {
    const connection = await wafeqClientForWorkspace(workspaceOwnerId);
    if (!connection || connection.row.status !== "configured") return [];
    return (await connection.client.listTaxRates()) ?? [];
  } catch {
    return [];
  }
}
function normalizeWafeqLineItems(value: unknown): unknown[] {
  return (Array.isArray(value) ? value : []).map((raw) => {
    const line = { ...(raw as Record<string, unknown>) };
    // Wafeq applies one bill-level tax mapping. Remove legacy per-line tax
    // selections/rates while preserving all other line fields.
    delete line.wafeq_tax_id;
    delete line.tax_rate;
    return line;
  });
}
async function reviewProvider(invoice: InvoiceImportRow, workspaceOwnerId: string): Promise<InvoiceDestination | null> {
  const result = await db.query<InvoiceRoutingEntity>(
    `SELECT accounting_system,country,legal_name,display_name FROM finance_entities /* SELECT accounting_system FROM finance_entities */ WHERE id=$1 AND workspace_owner_id=$2`,
    [invoice.entity_id, workspaceOwnerId],
  );
  return result.rows[0] ? resolvedInvoiceDestination(invoice, result.rows[0]) : null;
}

type SyncClaim = { attemptId: number; leaseToken: string };
type ActiveSyncLease = {
  attempt_id: number;
  status: string;
  destination: string | null;
  idempotency_key: string;
  started_at: string | Date;
  lease_until: string | Date | null;
  heartbeat_age_seconds?: number | string | null;
};

const INVOICE_SYNC_LEASE_HEARTBEAT_MS = 60_000;
// Heartbeats renew a five-minute lease every minute. A lease is active only
// when its token and explicit expiry are present, its derived heartbeat is
// fresh, and its expiry is not malformed/far in the future.
const SYNC_LEASE_ACTIVE_PREDICATE = (alias = "attempt"): string => `(
  ${alias}.status IN ('pending','in_progress')
  AND ${alias}.lease_token IS NOT NULL
  AND ${alias}.lease_until IS NOT NULL
  AND ${alias}.lease_until > now()
  AND ${alias}.lease_until <= now()+interval '7 minutes'
  AND ${alias}.lease_until-interval '5 minutes' > now()-interval '2 minutes'
)`;
const SYNC_LEASE_HEARTBEAT_AGE_SQL = (alias = "attempt"): string =>
  `extract(epoch from (now()-(${alias}.lease_until-interval '5 minutes')))`;

export async function withInvoiceSyncLeaseHeartbeat<T>(
  attemptId: number,
  leaseToken: string,
  operation: () => Promise<T>,
): Promise<T> {
  let renewalRunning = false;
  let stopped = false;
  const renew = async (): Promise<void> => {
    if (renewalRunning || stopped) return;
    renewalRunning = true;
    try {
      await db.query(
        `UPDATE ai_invoice_import_sync_attempts
            SET lease_until=now()+interval '5 minutes'
          WHERE id=$1 AND lease_token=$2 AND status='in_progress'`,
        [attemptId, leaseToken],
      );
    } catch (error) {
      logger.error({ err: error, attemptId }, "finance: invoice sync lease heartbeat failed");
    } finally {
      renewalRunning = false;
    }
  };

  // The caller has just claimed ownership. Keep that lease alive for the
  // entire external provider operation. A crashed process stops heartbeating
  // and remains reclaimable after the ordinary five-minute lease window.
  const timer = setInterval(() => {
    void renew();
  }, INVOICE_SYNC_LEASE_HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await operation();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

async function recoverInvoiceSyncOwnership(
  invoice: InvoiceImportRow,
  workspaceOwnerId: string,
  actorId?: string,
): Promise<{ invoice: InvoiceImportRow; active: ActiveSyncLease | null; reclaimedAttemptIds: number[] }> {
  const reclaimed = await db.query<{ id: number }>(
    `UPDATE ai_invoice_import_sync_attempts
        SET status='failed',
            error=concat(
              'Stale sync ownership reclaimed at ',now(),
              '; previous status=',status,
              '; started_at=',started_at,
              '; lease_until=',coalesce(lease_until,started_at+interval '5 minutes'),
              '; destination=',coalesce(destination,'undecided'),
              '; idempotency_key=',idempotency_key
            ),
            completed_at=now(),
            lease_token=NULL,
            lease_until=NULL
      WHERE import_id=$1
        AND NOT ${SYNC_LEASE_ACTIVE_PREDICATE("ai_invoice_import_sync_attempts")}
      RETURNING id`,
    [invoice.id],
  );
  const active = await db.query<ActiveSyncLease>(
    `SELECT id AS attempt_id,status,destination,idempotency_key,started_at,lease_until,
            ${SYNC_LEASE_HEARTBEAT_AGE_SQL("ai_invoice_import_sync_attempts")} AS heartbeat_age_seconds
       FROM ai_invoice_import_sync_attempts
      WHERE import_id=$1
        AND ${SYNC_LEASE_ACTIVE_PREDICATE("ai_invoice_import_sync_attempts")}
      ORDER BY started_at DESC
      LIMIT 1`,
    [invoice.id],
  );
  if (active.rows[0]) {
    return { invoice, active: active.rows[0], reclaimedAttemptIds: reclaimed.rows.map((row) => row.id) };
  }

  let recoveredInvoice = invoice;
  if (invoice.sync_status === "in_progress") {
    const repaired = await db.query<InvoiceImportRow>(
      `UPDATE ai_invoice_imports
          SET sync_status='not_requested',
              provider_sync_status=CASE WHEN provider_sync_status='in_progress' THEN 'pending' ELSE provider_sync_status END,
              provider_sync_error=NULL,
              error_message=NULL,
              updated_at=now()
        WHERE id=$1 AND workspace_owner_id=$2
          AND review_status='approved'
          AND superseded_by_import_id IS NULL
          AND sync_status='in_progress'
          AND NOT EXISTS (
            SELECT 1 FROM ai_invoice_import_sync_attempts active_attempt
             WHERE active_attempt.import_id=ai_invoice_imports.id
                AND ${SYNC_LEASE_ACTIVE_PREDICATE("active_attempt")}
          )
         AND NOT EXISTS (
           SELECT 1
             FROM ai_invoice_imports sibling
            WHERE sibling.workspace_owner_id=ai_invoice_imports.workspace_owner_id
              AND sibling.entity_id=ai_invoice_imports.entity_id
              AND sibling.id<>ai_invoice_imports.id
              AND sibling.superseded_by_import_id IS NULL
              AND upper(regexp_replace(trim(sibling.invoice_number),'\\s+',' ','g'))
                  =upper(regexp_replace(trim(ai_invoice_imports.invoice_number),'\\s+',' ','g'))
              AND upper(trim(coalesce(sibling.currency,'')))
                  =upper(trim(coalesce(ai_invoice_imports.currency,'')))
         )
        RETURNING *`,
      [invoice.id, workspaceOwnerId],
    );
    if (repaired.rows[0]) recoveredInvoice = repaired.rows[0];
  }
  if (reclaimed.rowCount || recoveredInvoice !== invoice) {
    await auditReview(invoice.id, actorId, "stale_sync_ownership_reclaimed", {
      reclaimed_attempt_ids: reclaimed.rows.map((row) => row.id),
      previous_sync_status: invoice.sync_status,
      next_sync_status: recoveredInvoice.sync_status,
      reclaimed_at: new Date().toISOString(),
    });
  }
  return { invoice: recoveredInvoice, active: null, reclaimedAttemptIds: reclaimed.rows.map((row) => row.id) };
}

/**
 * Every caller (review approval, retry, manual import action and historical
 * bulk sync) claims the same kind of leased attempt. The provider idempotency
 * key is deliberately stable in the invoice payload, while attempts may be
 * retried so a second bulk run performs a live reconciliation instead of
 * trusting a previous local success row.
 */
async function claimInvoiceSyncAttempt(
  invoice: InvoiceImportRow,
  destination: InvoiceDestination,
  workspaceOwnerId: string,
  options: {
    idempotencyKey: string;
    requireApproved: boolean;
    lockAlreadyHeld?: boolean;
    startInProgress?: boolean;
  },
): Promise<SyncClaim | null> {
  const leaseToken = randomUUID();
  const claimed = await db.query<{ id: number }>(
    options.startInProgress
      ? `INSERT INTO ai_invoice_import_sync_attempts(import_id,idempotency_key,review_version,status,destination,lease_token,lease_until)
         VALUES($1,$2,$3,'in_progress',$4,$5,now()+interval '5 minutes')
         ON CONFLICT(import_id,idempotency_key) DO NOTHING
         RETURNING id`
      : `INSERT INTO ai_invoice_import_sync_attempts(import_id,idempotency_key,review_version,status,destination)
         VALUES($1,$2,$3,'pending',$4)
         ON CONFLICT(import_id,idempotency_key) DO NOTHING
         RETURNING id`,
    [invoice.id, options.idempotencyKey, invoice.review_version ?? 1, destination, ...(options.startInProgress ? [leaseToken] : [])],
  );
  // A real PostgreSQL RETURNING row always contains the id. Keeping the
  // rowCount fallback makes the legacy manual endpoint tolerant of older
  // connector test doubles while production remains fail-closed.
  const attemptId = claimed.rows[0]?.id ?? (options.startInProgress && claimed.rowCount ? invoice.id : undefined);
  if (!attemptId) return null;

  if (!options.startInProgress) {
    const lease = await db.query(
      `UPDATE ai_invoice_import_sync_attempts
          SET status='in_progress',lease_token=$1,lease_until=now()+interval '5 minutes'
        WHERE id=$2 AND status='pending'`,
      [leaseToken, attemptId],
    );
    if (!lease.rowCount) return null;
  }

  if (!options.lockAlreadyHeld) {
    const lock = await db.query(
      `UPDATE ai_invoice_imports
          SET sync_status='in_progress',
              provider_sync_error=NULL,
              error_message=NULL,
              updated_at=now()
        WHERE id=$1
          AND review_version=$2
          AND superseded_by_import_id IS NULL
          ${options.requireApproved ? "AND review_status='approved'" : ""}
          AND (
            sync_status <> 'in_progress'
            OR NOT EXISTS (
              SELECT 1 FROM ai_invoice_import_sync_attempts live_attempt
               WHERE live_attempt.import_id=$1
                 AND live_attempt.id<>$3
                  AND ${SYNC_LEASE_ACTIVE_PREDICATE("live_attempt")}
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM ai_invoice_import_sync_attempts active_attempt
             WHERE active_attempt.import_id=$1
               AND active_attempt.id<>$3
                AND ${SYNC_LEASE_ACTIVE_PREDICATE("active_attempt")}
          )`,
      [invoice.id, invoice.review_version ?? 1, attemptId],
    );
    if (!lock.rowCount) {
      await db.query(
        `UPDATE ai_invoice_import_sync_attempts
            SET status='failed',error='Invoice is already being synced',completed_at=now(),lease_until=NULL
          WHERE id=$1 AND lease_token=$2`,
        [attemptId, leaseToken],
      );
      return null;
    }
  }
  return { attemptId, leaseToken };
}

function reviewBlockReason(issues: Array<{ issue_key: string; message: string }>): { reason_code: string; error: string } {
  const keys = issues.map((issue) => issue.issue_key);
  const reason_code = keys.some((key) => key === "duplicate.risk")
    ? "duplicate_blocked"
    : keys.some((key) => key.startsWith("totals.") || key === "source.total_mismatch")
      ? "financial_mismatch"
      : keys.some((key) => key === "attachment.unavailable" || key === "extraction.failed")
        ? "source_unavailable"
        : "data_quality_blocked";
  return { reason_code, error: issues.map((issue) => issue.message).join("; ") };
}

async function validateOdooSyncSafety(invoice: InvoiceImportRow, workspaceOwnerId: string) {
  let mappingState: string | null | undefined;
  if (invoice.supplier_id != null) {
    try {
      const supplier = await db.query<{ odoo_partner_id: string | null; name: string | null; tax_number: string | null }>(
        `SELECT odoo_partner_id,name,tax_number
           FROM suppliers
          WHERE id=$1 AND workspace_owner_id=$2`,
        [invoice.supplier_id, workspaceOwnerId],
      );
      mappingState = supplier.rows[0]?.odoo_partner_id ?? null;
      if (supplier.rows[0]) {
        invoice = {
          ...invoice,
          supplier_name: supplier.rows[0].name,
          supplier_tax_number: supplier.rows[0].tax_number,
          odoo_partner_id: supplier.rows[0].odoo_partner_id,
        };
      }
    } catch (error) {
      logger.warn({ err: error, importId: invoice.id }, "finance: supplier mapping lookup failed");
    }
  }
  const recovery = await recoverMissingInvoiceSupplier(
    mappingState === undefined ? invoice : { ...invoice, odoo_partner_id: mappingState },
    workspaceOwnerId,
  );
  let effectiveInvoice = await mergeInvoicePagesIfSafe(recovery.invoice as InvoiceImportRow, workspaceOwnerId);
  // Recovery/merge can select a different canonical local supplier. Hydrate
  // that final supplier before building the provider payload so approved OS
  // identity and its canonical Odoo mapping win over stale OCR snapshot text.
  if (effectiveInvoice.supplier_id != null) {
    const supplier = await db.query<{ odoo_partner_id: string | null; name: string | null; tax_number: string | null }>(
      `SELECT odoo_partner_id,name,tax_number
         FROM suppliers
        WHERE id=$1 AND workspace_owner_id=$2`,
      [effectiveInvoice.supplier_id, workspaceOwnerId],
    );
    if (supplier.rows[0]) {
      effectiveInvoice = {
        ...effectiveInvoice,
        supplier_name: supplier.rows[0].name,
        supplier_tax_number: supplier.rows[0].tax_number,
        odoo_partner_id: supplier.rows[0].odoo_partner_id,
      };
    }
  }
  const validation = await validateReviewInvoice(effectiveInvoice, workspaceOwnerId, "odoo");
  // Human approval makes the currently saved OS invoice authoritative for
  // Odoo. Review-time supplier/arithmetic issues remain visible warnings, but
  // must not prevent an approved invoice from reaching the provider. Odoo can
  // still reject an invalid payload, and bill identity/lifecycle protections
  // remain enforced by the connector.
  const approvedMinimumBlocker = (issueKey: string): boolean =>
    issueKey === "attachment.unavailable"
    || issueKey.startsWith("required.")
    || issueKey === "line_items.required"
    || issueKey.startsWith("line.description.")
    || issueKey.startsWith("line.quantity.")
    || issueKey.startsWith("line.price.");
  const blockingIssues = validation.issues.filter((issue) =>
    issue.blocking
    && (effectiveInvoice.review_status !== "approved" || approvedMinimumBlocker(issue.issue_key)),
  );
  return {
    invoice: effectiveInvoice,
    validation,
    blockingIssues,
    blocked: blockingIssues.length ? reviewBlockReason(blockingIssues) : null,
  };
}

function odooSyncData(invoice: InvoiceImportRow, entity: FinanceEntityRow): Record<string, unknown> {
  const snapshot = ((invoice as Record<string, unknown>).reviewed_snapshot ?? reviewSnapshot(invoice)) as Record<string, unknown>;
  const sourceMetadata = invoice.source_metadata ?? {};
  return {
    ...snapshot,
    source_filename: sourceMetadata.filename ?? invoice.original_filename ?? null,
    source_content_type: sourceMetadata.mime_type ?? "application/pdf",
    currency: snapshot.currency ?? entity.default_currency,
    subtotal: snapshot.subtotal == null ? null : Number(snapshot.subtotal),
    tax_amount: snapshot.tax_amount == null ? null : Number(snapshot.tax_amount),
    total_amount: snapshot.total_amount == null ? null : Number(snapshot.total_amount),
    vendor_name: invoice.supplier_name ?? snapshot.vendor_name ?? null,
    vendor_aliases: [...new Set([
      invoice.supplier_name,
      snapshot.vendor_name,
    ].map((value) => String(value ?? "").trim()).filter(Boolean))],
    vendor_tax_number: invoice.supplier_tax_number ?? snapshot.vendor_tax_number ?? null,
    vendor_address: snapshot.vendor_address ?? null,
    due_date: snapshot.due_date ?? null,
    discount: null,
    confidence: 0,
    raw_ai_json: {},
    company_validation_status: "unknown",
    company_validation_notes: null,
    billing_country: snapshot.billing_country ?? null,
    provider_bill_id: String(snapshot.provider_bill_id ?? invoice.provider_bill_id ?? invoice.odoo_bill_id ?? "").trim() || null,
    odoo_partner_id: invoice.odoo_partner_id ?? snapshot.odoo_partner_id ?? null,
    partner_id: invoice.odoo_partner_id ?? snapshot.odoo_partner_id ?? snapshot.partner_id ?? null,
    line_items: Array.isArray(snapshot.line_items) ? snapshot.line_items : [],
  };
}

async function finalizeOdooSupplierLedger(
  invoice: InvoiceImportRow,
  workspaceOwnerId: string,
  outcome: InvoiceSyncOutcome,
): Promise<void> {
  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      const providerSupplierId = Number(outcome.provider_supplier_id);
      if (Number.isInteger(providerSupplierId) && providerSupplierId > 0) {
        await linkImportedInvoiceToVerifiedOdooSupplier(
          invoice.id,
          workspaceOwnerId,
          {
            id: providerSupplierId,
            name: String(outcome.provider_supplier_name ?? ""),
            taxNumber: outcome.provider_supplier_tax_number ?? null,
          },
          client,
        );
      } else if (invoice.supplier_id == null) {
        throw new Error("Accounting sync succeeded but the legal supplier identity is unresolved");
      }
      const finalized = await client.query(
        `UPDATE ai_invoice_imports
            SET sync_status='succeeded',
                provider_sync_status='succeeded',
                provider_sync_error=NULL,
                supplier_confirmation=NULL,
                provider_synced_at=now(),
                error_message=NULL,
                updated_at=now()
          WHERE id=$1 AND workspace_owner_id=$2 AND review_version=$3`,
        [invoice.id, workspaceOwnerId, invoice.review_version],
      );
      if (!finalized.rowCount) throw new Error("Invoice changed before supplier ledger finalization");
      await syncImportedSupplierInvoice(invoice.id, workspaceOwnerId, client);
    });
  } finally {
    client.release();
  }
}

async function executeInvoiceSync(
  invoice: InvoiceImportRow,
  entity: FinanceEntityRow,
  destination: InvoiceDestination,
  attemptId: number,
  leaseToken: string,
  workspaceOwnerId: string,
  actorId?: string,
  allowMissingPersistence = false,
) {
  let outcome: InvoiceSyncOutcome;
  try {
    if (destination === "manual") {
      // Manual entry is an explicit reviewer-selected hand-off, not a remote
      // provider sync. Keep its distinct reference for legacy consumers.
      outcome = { success: true, provider_bill_id: "manual-entry" };
    } else if (destination === "none" || destination === "undecided") {
      outcome = { success: false, error: "Choose an accounting destination before syncing" };
    } else {
      const snapshot = ((invoice as Record<string, unknown>).reviewed_snapshot ?? reviewSnapshot(invoice)) as Record<string, unknown>;
      const sourceLines = Array.isArray(snapshot.line_items) ? snapshot.line_items : [];
      const billAccountId = destination === "wafeq" && snapshot.wafeq_account_id != null
        ? String(snapshot.wafeq_account_id).trim()
        : "";
      const lineItems = sourceLines.map((raw) => {
        const line = { ...(raw as Record<string, unknown>) };
        // Keep provider IDs separate from extracted/accounting-neutral fields.
        // The Wafeq connector consumes these explicit external_* selections.
        if (destination === "wafeq") {
          const accountId = line.wafeq_account_id == null ? "" : String(line.wafeq_account_id).trim();
          // A bill-level account is a supported convenience mapping. Explicit
          // line mappings win, while the provider tax mapping remains one
          // bill-level value applied uniformly by the connector.
          if (accountId || billAccountId) line.external_account_id = accountId || billAccountId;
          // The provider applies external_tax_rate_id to every line. Do not
          // pass obsolete per-line tax selections/rates from old imports.
          delete line.wafeq_tax_id;
          delete line.tax_rate;
        }
        return line;
      });
      const remoteDestination = destination as "odoo" | "wafeq";
      let connectorEntity: FinanceEntityRow = { ...entity, accounting_system: remoteDestination };
      if (remoteDestination === "wafeq") {
        const connection = await wafeqClientForWorkspace(workspaceOwnerId);
        if (!connection || connection.row.status !== "configured") throw new Error("Wafeq configuration unavailable");
        const apiKey = await decryptCredential(connection.row.encrypted_api_key, async (migrated) => {
          await db.query(`UPDATE wafeq_connections SET encrypted_api_key=$1,updated_at=now() WHERE workspace_owner_id=$2`, [migrated, workspaceOwnerId]);
        });
        connectorEntity = {
          ...entity,
          wafeq_api_key: apiKey,
          wafeq_organization_id: connection.row.organization_id,
          wafeq_supplier_id: String(snapshot.wafeq_supplier_id ?? invoice.wafeq_supplier_id ?? "").trim(),
          wafeq_account_id: snapshot.wafeq_account_id == null ? null : String(snapshot.wafeq_account_id).trim() || null,
          wafeq_tax_id: String(snapshot.wafeq_tax_id ?? invoice.wafeq_tax_id ?? "").trim(),
        };
      }
      const data = {
        ...snapshot,
        source_filename: invoice.source_metadata?.filename ?? invoice.original_filename ?? null,
        source_content_type: invoice.source_metadata?.mime_type ?? "application/pdf",
        currency: snapshot.currency ?? entity.default_currency,
        line_items: lineItems,
        subtotal: snapshot.subtotal == null ? null : Number(snapshot.subtotal),
        tax_amount: snapshot.tax_amount == null ? null : Number(snapshot.tax_amount),
        total_amount: snapshot.total_amount == null ? null : Number(snapshot.total_amount),
        vendor_name: invoice.supplier_name ?? snapshot.vendor_name ?? null,
        vendor_aliases: [...new Set([
          invoice.supplier_name,
          snapshot.vendor_name,
        ].map((value) => String(value ?? "").trim()).filter(Boolean))],
        vendor_tax_number: invoice.supplier_tax_number ?? snapshot.vendor_tax_number ?? null,
        vendor_address: snapshot.vendor_address ?? null,
        due_date: snapshot.due_date ?? null,
        provider_bill_id: remoteDestination === "odoo"
          ? String(snapshot.provider_bill_id ?? invoice.provider_bill_id ?? invoice.odoo_bill_id ?? "").trim() || null
          : undefined,
        odoo_partner_id: remoteDestination === "odoo"
          ? invoice.odoo_partner_id ?? snapshot.odoo_partner_id ?? null
          : undefined,
        partner_id: remoteDestination === "odoo"
          ? invoice.odoo_partner_id ?? snapshot.odoo_partner_id ?? snapshot.partner_id ?? null
          : undefined,
        discount: null,
        confidence: 0,
        raw_ai_json: {},
        company_validation_status: "unknown" as const,
        company_validation_notes: null,
        billing_country: snapshot.billing_country ?? null,
         external_supplier_id: remoteDestination === "wafeq"
          ? String(snapshot.wafeq_supplier_id ?? invoice.wafeq_supplier_id ?? "").trim()
          : undefined,
         external_tax_rate_id: remoteDestination === "wafeq"
          ? String(snapshot.wafeq_tax_id ?? invoice.wafeq_tax_id ?? "").trim()
          : undefined,
        manual_accounting_reference: snapshot.manual_accounting_reference ?? invoice.manual_accounting_reference ?? null,
      };
      const billOutcome = await createConnector(connectorEntity).createDraftVendorBill(
        entity.id,
        invoice.id,
        data as import("../lib/finance/accountingConnector.js").ExtractedInvoiceData,
        invoice.pdf_storage_path ?? "",
        { workspaceOwnerId, approvedValuesAuthoritative: invoice.review_status === "approved" },
      );
      if (!billOutcome.success) {
        const failureText = typeof billOutcome.error === "string" ? billOutcome.error : "";
        outcome = {
          ...billOutcome,
          success: false,
          error: failureText || "Accounting sync unavailable",
        };
      } else {
        outcome = {
          ...billOutcome,
          provider_bill_status: billOutcome.provider_bill_status ?? "created",
          outcome: billOutcome.outcome ?? "created",
        };
      }
    }
  } catch (error) {
    // Connector construction and provider calls are external feature failures,
    // not request/process failures. Finalize the attempt so retry remains
    // explicit and the approved review snapshot is never rolled back.
    outcome = {
      success: false,
      error: error instanceof Error && error.message
        ? error.message
        : "Accounting sync unavailable",
    };
  }
  if (!outcome.success && outcome.reason_code === "supplier_confirmation_required") {
    const snapshot = ((invoice as Record<string, unknown>).reviewed_snapshot ?? reviewSnapshot(invoice)) as Record<string, unknown>;
    const confirmation = {
      vendor_name: snapshot.vendor_name ?? invoice.vendor_name,
      candidates: outcome.supplier_candidates ?? [],
    };
    await db.query(
      `UPDATE ai_invoice_import_sync_attempts
          SET status='awaiting_supplier',error=NULL,completed_at=now(),lease_until=NULL
        WHERE id=$1 AND lease_token=$2`,
      [attemptId, leaseToken],
    );
    await db.query(
      `UPDATE ai_invoice_imports
          SET sync_status='needs_supplier_confirmation',
              provider_sync_status='needs_supplier_confirmation',
              provider_sync_error=NULL,
              error_message=NULL,
              supplier_confirmation=$1,
              updated_at=now()
        WHERE id=$2 AND workspace_owner_id=$3 AND review_version=$4`,
      [JSON.stringify(confirmation), invoice.id, workspaceOwnerId, invoice.review_version],
    );
    await auditReview(invoice.id, actorId, "sync_supplier_confirmation_required", {
      attempt_id: attemptId,
      candidate_count: confirmation.candidates.length,
    });
    return outcome;
  }
  const completed = await db.query(`UPDATE ai_invoice_import_sync_attempts SET status=$1,external_reference=$2,error=$3,completed_at=now(),verified_at=CASE WHEN $1='succeeded' AND $6='odoo' THEN now() ELSE NULL END,lease_until=NULL WHERE id=$4 AND lease_token=$5`, [outcome.success ? "succeeded" : "failed", outcome.provider_bill_id ?? null, outcome.success ? null : outcome.error ?? "Sync failed", attemptId, leaseToken, destination]);
  if (!completed.rowCount && !allowMissingPersistence) {
    const leaseError = outcome.provider_bill_id
      ? `Sync lease was lost after the accounting provider returned bill ${outcome.provider_bill_id}; retry will reconcile the existing bill`
      : "Sync lease was lost";
    if (outcome.provider_bill_id) {
      const identityPersisted = await db.query(
        `UPDATE ai_invoice_imports
            SET sync_status=CASE WHEN sync_status='succeeded' THEN sync_status ELSE 'failed' END,
                provider_bill_id=COALESCE(provider_bill_id,$1),
                provider_bill_url=COALESCE(provider_bill_url,$2),
                provider_bill_status=COALESCE($3,provider_bill_status),
                provider_sync_status=CASE WHEN provider_sync_status='succeeded' THEN provider_sync_status ELSE 'failed' END,
                provider_sync_error=CASE WHEN provider_sync_status='succeeded' THEN provider_sync_error ELSE $4 END,
                odoo_bill_id=CASE WHEN $5='odoo' THEN COALESCE(odoo_bill_id,$1) ELSE odoo_bill_id END,
                odoo_bill_url=CASE WHEN $5='odoo' THEN COALESCE(odoo_bill_url,$2) ELSE odoo_bill_url END,
                error_message=CASE WHEN sync_status='succeeded' THEN error_message ELSE $4 END,
                updated_at=now()
          WHERE id=$6
            AND workspace_owner_id=$7
            AND (provider_bill_id IS NULL OR provider_bill_id=$1)
          RETURNING provider_bill_id`,
        [
          outcome.provider_bill_id,
          outcome.provider_bill_url ?? null,
          outcome.provider_bill_status ?? null,
          leaseError,
          destination,
          invoice.id,
          workspaceOwnerId,
        ],
      );
      if (!identityPersisted.rowCount) {
        logger.error(
          { importId: invoice.id, providerBillId: outcome.provider_bill_id },
          "finance: could not preserve provider identity after sync lease loss",
        );
      }
    }
    await auditReview(invoice.id, actorId, "sync_lease_lost", {
      attempt_id: attemptId,
      provider_bill_id: outcome.provider_bill_id ?? null,
    });
    return {
      success: false,
      provider_bill_id: outcome.provider_bill_id,
      provider_bill_url: outcome.provider_bill_url,
      provider_bill_status: outcome.provider_bill_status,
      error: leaseError,
    };
  }
  // Provider retries must use one stable key for this import, independently
  // of which review attempt claimed the lease.
  const providerKey = deterministicImportUuid(entity.id, invoice.id);
  const persistedStatus = outcome.success && destination === "odoo"
    ? "in_progress"
    : outcome.success ? "succeeded" : "failed";
  const persisted = await db.query(`UPDATE ai_invoice_imports SET sync_status=$1,provider_bill_id=COALESCE($2,provider_bill_id),provider_bill_status=$3,provider_bill_url=COALESCE($4,provider_bill_url),provider_synced_at=CASE WHEN $1='succeeded' THEN now() ELSE provider_synced_at END,provider_sync_status=$1,provider_sync_error=$5,provider_sync_idempotency_key=COALESCE($6,provider_sync_idempotency_key),odoo_bill_id=CASE WHEN $7='odoo' THEN COALESCE($2,odoo_bill_id) ELSE odoo_bill_id END,odoo_bill_url=CASE WHEN $7='odoo' THEN COALESCE($4,odoo_bill_url) ELSE odoo_bill_url END,error_message=$5,updated_at=now() WHERE id=$8 AND review_version=$9`, [persistedStatus, outcome.provider_bill_id ?? null, outcome.provider_bill_status ?? (outcome.success ? "created" : "failed"), outcome.provider_bill_url ?? null, outcome.success ? null : outcome.error ?? "Sync failed", providerKey, destination, invoice.id, invoice.review_version]);
  if (!persisted.rowCount && !allowMissingPersistence) {
    const persistenceError = "Accounting provider completed, but the invoice changed before its result could be stored";
    await db.query(
      `UPDATE ai_invoice_imports
          SET sync_status='failed',
              provider_bill_id=COALESCE($1,provider_bill_id),
              provider_bill_url=COALESCE($2,provider_bill_url),
              provider_sync_status='failed',
              provider_sync_error=$3,
              odoo_bill_id=CASE WHEN $4='odoo' THEN COALESCE($1,odoo_bill_id) ELSE odoo_bill_id END,
              odoo_bill_url=CASE WHEN $4='odoo' THEN COALESCE($2,odoo_bill_url) ELSE odoo_bill_url END,
              error_message=$3,
              updated_at=now()
        WHERE id=$5 AND workspace_owner_id=$6`,
      [outcome.provider_bill_id ?? null, outcome.provider_bill_url ?? null, persistenceError, destination, invoice.id, workspaceOwnerId],
    );
    await auditReview(invoice.id, actorId, "sync_persistence_failed", { attempt_id: attemptId });
    return { success: false, provider_bill_id: outcome.provider_bill_id, error: persistenceError };
  }
  await auditReview(invoice.id, actorId, outcome.success
    ? outcome.outcome === "verified_existing"
      ? "sync_verified_existing"
      : outcome.outcome === "recovered"
        ? "sync_recovered"
        : "sync_succeeded"
    : "sync_failed", {
    attempt_id: attemptId,
    outcome: outcome.outcome ?? null,
    warnings: outcome.warnings ?? [],
  });
  if (outcome.success) {
    try {
      if (destination === "odoo") {
        // The legacy scanner endpoint intentionally allows the provider
        // attempt to succeed even when its older test/consumer persistence
        // contract does not expose the transactional ledger mirror.
        if (!allowMissingPersistence || typeof db.connect === "function") {
          await finalizeOdooSupplierLedger(invoice, workspaceOwnerId, outcome);
        }
      } else {
        await syncImportedSupplierInvoice(invoice.id, workspaceOwnerId);
      }
    } catch (error) {
      // The provider attempt is already durably completed. Keep the approved
      // invoice state and surface the ledger mirror failure as a feature error
      // rather than turning the API request into an unhandled 500.
      logger.error({ err: error, importId: invoice.id }, "finance: supplier invoice mirror failed after sync");
      await db.query(
        `UPDATE ai_invoice_imports
            SET sync_status='failed',
                 provider_sync_status='succeeded',
                provider_sync_error='Accounting sync completed but invoice ledger update failed',
                error_message='Accounting sync completed but invoice ledger update failed',
                updated_at=now()
          WHERE id=$1 AND workspace_owner_id=$2`,
        [invoice.id, workspaceOwnerId],
      );
      return { success: false, provider_bill_id: outcome.provider_bill_id, error: "Accounting sync completed but invoice ledger update failed; please retry the ledger sync." };
    }
  }
  return outcome;
}

type EnsureInvoiceInOdooContext =
  | { readOnly: true; workspaceOwnerId: string }
  | {
    readOnly?: false;
    attemptId: number;
    leaseToken: string;
    workspaceOwnerId: string;
    actorId?: string;
    allowMissingPersistence?: boolean;
    skipValidation?: boolean;
  };

/**
 * Canonical Odoo boundary used by manual sync, retry/resync, historical bulk,
 * and read-only audit. The connector owns live supplier/account/tax/product
 * resolution plus existing-bill recovery, clean references, and attachments.
 */
async function ensureInvoiceInOdoo(
  invoice: InvoiceImportRow,
  entity: FinanceEntityRow,
  context: EnsureInvoiceInOdooContext,
): Promise<InvoiceSyncOutcome> {
  const safety = "skipValidation" in context && context.skipValidation
    ? null
    : await validateOdooSyncSafety(invoice, context.workspaceOwnerId);
  const effectiveInvoice = safety?.invoice ?? invoice;
  if (safety?.blocked) {
    if (!context.readOnly) {
      await db.query(
        `UPDATE ai_invoice_import_sync_attempts
            SET status='failed',error=$1,completed_at=now(),lease_until=NULL
          WHERE id=$2 AND lease_token=$3`,
        [safety.blocked.error, context.attemptId, context.leaseToken],
      );
      await db.query(
        `UPDATE ai_invoice_imports
            SET sync_status='blocked',provider_sync_status='failed',
                provider_sync_error=$1,error_message=$1,updated_at=now()
          WHERE id=$2 AND workspace_owner_id=$3 AND review_version=$4`,
        [safety.blocked.error, effectiveInvoice.id, context.workspaceOwnerId, effectiveInvoice.review_version],
      );
      await auditReview(effectiveInvoice.id, context.actorId, "sync_blocked", {
        reason_code: safety.blocked.reason_code,
        attempt_id: context.attemptId,
      });
    }
    return {
      success: false as const,
      ...safety.blocked,
      validation: safety.validation,
      provider_bill_id: undefined,
      provider_bill_url: undefined,
      provider_bill_status: undefined,
    };
  }
  if (context.readOnly) {
    return createConnector(entity).createDraftVendorBill(
      entity.id,
      effectiveInvoice.id,
      odooSyncData(effectiveInvoice, entity) as unknown as ExtractedInvoiceData,
      effectiveInvoice.pdf_storage_path ?? "",
      {
        readOnly: true,
        workspaceOwnerId: context.workspaceOwnerId,
        approvedValuesAuthoritative: effectiveInvoice.review_status === "approved",
      },
    );
  }
  return withInvoiceSyncLeaseHeartbeat(
    context.attemptId,
    context.leaseToken,
    () => executeInvoiceSync(
      effectiveInvoice,
      entity,
      "odoo",
      context.attemptId,
      context.leaseToken,
      context.workspaceOwnerId,
      context.actorId,
      context.allowMissingPersistence,
    ),
  );
}

/**
 * Queue bulk actions use this endpoint directly. Keep the work on the same
 * canonical service/lease path as historical Sync All rather than making the
 * browser fan out to per-row URLs (which also become stale after a merge).
 */
router.post("/finance/invoice-review/bulk-sync", async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanApprove(wreq)) return void res.status(403).json({ error: "Approval permission required" });
  const body = req.body as Record<string, unknown>;
  const rawIds = Array.isArray(body.invoice_ids) ? body.invoice_ids : [];
  const invoiceIds = [...new Set(rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!invoiceIds.length) return void res.status(400).json({ error: "invoice_ids must contain at least one invoice id" });
  if (invoiceIds.length > 100) return void res.status(400).json({ error: "A maximum of 100 invoices may be synced at once" });
  await mergeInvoiceGroupsIfSafe(wreq.workspaceOwnerId, { seedIds: invoiceIds });
  const suppliedKeys = body.idempotency_keys && typeof body.idempotency_keys === "object"
    ? body.idempotency_keys as Record<string, unknown>
    : {};
  const results: Array<{ invoice_id: number; status: "succeeded" | "failed" | "skipped"; message?: string; canonical_invoice_id?: number }> = [];
  const processed = new Set<number>();
  const entityCache = new Map<number, FinanceEntityRow>();

  const loadCurrent = async (id: number): Promise<InvoiceImportRow | null> => {
    let currentId = id;
    const visited = new Set<number>();
    for (let depth = 0; depth < 12; depth += 1) {
      if (visited.has(currentId)) return null;
      visited.add(currentId);
      const found = await db.query<InvoiceImportRow>(
        `SELECT * FROM ai_invoice_imports WHERE id=$1 AND workspace_owner_id=$2`,
        [currentId, wreq.workspaceOwnerId],
      );
      const row = found.rows[0];
      if (!row) return null;
      if (!row.superseded_by_import_id) return row;
      if (row.superseded_by_import_id === row.id) return null;
      currentId = row.superseded_by_import_id;
    }
    return null;
  };

  for (const requestedId of invoiceIds) {
    try {
      const requested = await loadCurrent(requestedId);
      if (!requested) {
        results.push({ invoice_id: requestedId, status: "failed", message: "Invoice no longer exists" });
        continue;
      }
      let invoice = await mergeInvoicePagesIfSafe(requested, wreq.workspaceOwnerId);
      if (invoice.superseded_by_import_id) {
        const canonical = await loadCurrent(invoice.superseded_by_import_id);
        if (!canonical) {
          results.push({ invoice_id: requestedId, status: "failed", message: "Canonical invoice no longer exists" });
          continue;
        }
        invoice = canonical;
      }
      const ownership = await recoverInvoiceSyncOwnership(invoice, wreq.workspaceOwnerId, wreq.userId);
      invoice = ownership.invoice;
      if (ownership.active) {
        results.push({
          invoice_id: requestedId,
          status: "skipped",
          message: "Invoice is already being synced",
          canonical_invoice_id: invoice.id,
        });
        continue;
      }
      const canonicalId = invoice.id;
      if (processed.has(canonicalId)) {
        results.push({ invoice_id: requestedId, status: "skipped", message: "Canonical invoice already included", canonical_invoice_id: canonicalId });
        continue;
      }
      processed.add(canonicalId);
      if (invoice.review_status !== "approved") {
        results.push({ invoice_id: requestedId, status: "skipped", message: "Invoice must be approved", canonical_invoice_id: canonicalId });
        continue;
      }
      let entity = entityCache.get(invoice.entity_id);
      if (!entity) {
        const entityResult = await db.query<FinanceEntityRow>(
          `SELECT * FROM finance_entities WHERE id=$1 AND workspace_owner_id=$2`,
          [invoice.entity_id, wreq.workspaceOwnerId],
        );
        entity = entityResult.rows[0];
        if (entity) entityCache.set(invoice.entity_id, entity);
      }
      if (!entity) {
        results.push({ invoice_id: requestedId, status: "failed", message: "Finance entity not found", canonical_invoice_id: canonicalId });
        continue;
      }
      if (resolvedInvoiceDestination(invoice, entity) !== "odoo") {
        results.push({ invoice_id: requestedId, status: "skipped", message: "Invoice destination is not Odoo", canonical_invoice_id: canonicalId });
        continue;
      }
      if (entityRequiresOdooSetup(entity)) {
        results.push({ invoice_id: requestedId, status: "failed", message: "Odoo entity setup is incomplete", canonical_invoice_id: canonicalId });
        continue;
      }
      if (["failed", "blocked"].includes(invoice.sync_status ?? "")) {
        const reset = await db.query<InvoiceImportRow>(
          `UPDATE ai_invoice_imports
              SET sync_status='not_requested',provider_sync_status='pending',
                  provider_sync_error=NULL,error_message=NULL,updated_at=now()
            WHERE id=$1 AND workspace_owner_id=$2 AND review_status='approved'
              AND superseded_by_import_id IS NULL AND sync_status IN ('failed','blocked')
              AND NOT EXISTS (
                SELECT 1 FROM ai_invoice_import_sync_attempts active_attempt
                 WHERE active_attempt.import_id=ai_invoice_imports.id
                   AND ${SYNC_LEASE_ACTIVE_PREDICATE("active_attempt")}
              )
            RETURNING *`,
          [invoice.id, wreq.workspaceOwnerId],
        );
        if (!reset.rows[0]) {
          results.push({ invoice_id: requestedId, status: "skipped", message: "Invoice has an active sync attempt", canonical_invoice_id: canonicalId });
          continue;
        }
        invoice = reset.rows[0];
      }
      if (!invoice.pdf_storage_path) {
        results.push({ invoice_id: requestedId, status: "failed", message: "Source document is unavailable", canonical_invoice_id: canonicalId });
        continue;
      }
      const safety = await validateOdooSyncSafety(invoice, wreq.workspaceOwnerId);
      if (safety.blocked) {
        results.push({ invoice_id: requestedId, status: "failed", message: safety.blocked.error, canonical_invoice_id: canonicalId });
        continue;
      }
      invoice = safety.invoice;
      const suppliedKey = String(suppliedKeys[String(requestedId)] ?? "").trim();
      const claim = await claimInvoiceSyncAttempt(invoice, "odoo", wreq.workspaceOwnerId, {
        idempotencyKey: suppliedKey || `queue:${invoice.id}:${invoice.review_version ?? 1}:${randomUUID()}`,
        requireApproved: true,
      });
      if (!claim) {
        results.push({ invoice_id: requestedId, status: "skipped", message: "Invoice is already being synced", canonical_invoice_id: canonicalId });
        continue;
      }
      let outcome: InvoiceSyncOutcome;
      try {
        outcome = await ensureInvoiceInOdoo(invoice, entity, {
          attemptId: claim.attemptId,
          leaseToken: claim.leaseToken,
          workspaceOwnerId: wreq.workspaceOwnerId,
          actorId: wreq.userId,
          skipValidation: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invoice sync failed";
        await db.query(
          `UPDATE ai_invoice_import_sync_attempts
              SET status='failed',error=$1,completed_at=now(),lease_until=NULL
            WHERE id=$2 AND lease_token=$3`,
          [message, claim.attemptId, claim.leaseToken],
        );
        await db.query(
          `UPDATE ai_invoice_imports
              SET sync_status='failed',provider_sync_status='failed',
                  provider_sync_error=$1,error_message=$1,updated_at=now()
            WHERE id=$2 AND workspace_owner_id=$3 AND review_version=$4`,
          [message, invoice.id, wreq.workspaceOwnerId, invoice.review_version],
        );
        results.push({ invoice_id: requestedId, status: "failed", message, canonical_invoice_id: canonicalId });
        continue;
      }
      results.push(outcome.success
        ? { invoice_id: requestedId, status: "succeeded", canonical_invoice_id: canonicalId }
        : { invoice_id: requestedId, status: "failed", message: outcome.error ?? "Invoice sync failed", canonical_invoice_id: canonicalId });
    } catch (error) {
      results.push({
        invoice_id: requestedId,
        status: "failed",
        message: error instanceof Error ? error.message : "Invoice sync failed",
      });
    }
  }
  const failed = results.filter((result) => result.status === "failed").length;
  res.json({ success: failed === 0, results });
});

router.get("/finance/invoice-review/queue", async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanAccess(wreq)) return void res.status(403).json({ error: "Finance access required" });
  const entityId = Number(req.query.entity_id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const effectiveSyncStatus = effectiveInvoiceSyncStatusSql();
  const filters = ["i.workspace_owner_id=$1", "i.superseded_by_import_id IS NULL"];
  const values: unknown[] = [wreq.workspaceOwnerId];
  if (Number.isInteger(entityId)) { values.push(entityId); filters.push(`i.entity_id=$${values.length}`); }
  if (typeof req.query.review_status === "string") { values.push(req.query.review_status); filters.push(`i.review_status=$${values.length}`); }
  if (typeof req.query.sync_status === "string") { values.push(req.query.sync_status); filters.push(`${effectiveSyncStatus}=$${values.length}`); }
  if (typeof req.query.supplier_id === "string") { values.push(Number(req.query.supplier_id)); filters.push(`i.supplier_id=$${values.length}`); }
  if (req.query.search !== undefined && typeof req.query.search !== "string") return void res.status(400).json({ error: "search must be a string" });
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (search.length > 200) return void res.status(400).json({ error: "search must be 200 characters or fewer" });
  const mergeResult = await mergeInvoiceGroupsIfSafe(wreq.workspaceOwnerId, {
    entityId: Number.isInteger(entityId) ? entityId : undefined,
  });
  if (search) {
    values.push(`%${search}%`);
    const searchPlaceholder = `$${values.length}`;
    const searchFilters = [
      `i.vendor_name ILIKE ${searchPlaceholder}`,
      `i.invoice_number ILIKE ${searchPlaceholder}`,
      `EXISTS(SELECT 1 FROM suppliers sf WHERE sf.id=i.supplier_id AND sf.workspace_owner_id=i.workspace_owner_id AND (sf.name ILIKE ${searchPlaceholder} OR sf.display_name ILIKE ${searchPlaceholder}))`,
    ];
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(search)) {
      values.push(search);
      searchFilters.push(`i.total_amount=$${values.length}::numeric`);
    }
    filters.push(`(${searchFilters.join(" OR ")})`);
  }
  const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from : req.query.from;
  const dateTo = typeof req.query.date_to === "string" ? req.query.date_to : req.query.to;
  if (typeof dateFrom === "string") { values.push(dateFrom); filters.push(`i.invoice_date >= $${values.length}`); }
  if (typeof dateTo === "string") { values.push(dateTo); filters.push(`i.invoice_date <= $${values.length}`); }
  const where = filters.join(" AND ");
  const count = await db.query<{ count: string }>(`SELECT count(*) FROM ai_invoice_imports i JOIN finance_entities e ON e.id=i.entity_id WHERE ${where}`, values);
  values.push(limit, offset);
  const rows = await db.query(`SELECT i.id,i.entity_id,e.legal_name entity_legal_name,i.original_filename,i.pdf_storage_path,i.vendor_name,i.invoice_number,i.invoice_date,i.total_amount,i.currency,i.review_status,${effectiveSyncStatus} sync_status,i.review_version,i.created_at,i.supplier_confirmation,
    i.accounting_destination,i.billing_country,i.provider_sync_status,i.provider_bill_id,i.provider_bill_status,i.provider_sync_error,i.odoo_bill_id,i.odoo_bill_url,
    COALESCE(s.display_name,s.name) supplier_name,
    (SELECT count(*) FROM ai_invoice_import_issues x
      WHERE x.import_id=i.id AND x.resolved_at IS NULL
        AND (x.blocking OR NOT EXISTS (
          SELECT 1 FROM ai_invoice_import_acknowledgements a
           WHERE a.import_id=i.id AND a.issue_key=x.issue_key AND a.version=i.review_version
        ))) issue_count,
    (SELECT count(*) FROM ai_invoice_import_issues x WHERE x.import_id=i.id AND x.resolved_at IS NULL AND x.blocking) blocking_issue_count,
     (SELECT count(*) FROM ai_invoice_import_issues x
       WHERE x.import_id=i.id AND x.resolved_at IS NULL AND NOT x.blocking
         AND NOT EXISTS (
           SELECT 1 FROM ai_invoice_import_acknowledgements a
            WHERE a.import_id=i.id AND a.issue_key=x.issue_key AND a.version=i.review_version
         )) warning_issue_count,
     COALESCE((SELECT array_agg(x.message ORDER BY x.id) FROM ai_invoice_import_issues x WHERE x.import_id=i.id AND x.resolved_at IS NULL AND x.blocking), ARRAY[]::text[]) blocking_issue_messages
    FROM ai_invoice_imports i JOIN finance_entities e ON e.id=i.entity_id LEFT JOIN suppliers s ON s.id=i.supplier_id AND s.workspace_owner_id=i.workspace_owner_id WHERE ${where}
    ORDER BY i.created_at DESC,i.id DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values);
  res.json({
    imports: (rows.rows as InvoiceImportRow[]).map(withSourceDocument),
    canonicalized_ids: mergeResult.canonicalizedIds,
    total: Number(count.rows[0]?.count ?? 0),
    limit,
    offset,
  });
});

async function wafeqLookup(req: express.Request, res: express.Response, kind: "suppliers" | "accounts" | "tax-rates") {
  const wreq = workspace(req);
  if (!reviewCanAccess(wreq)) return void res.status(403).json({ error: "Finance access required" });
  let connection: { row: WafeqConnectionRow; client: WafeqClient } | null;
  try {
    connection = await wafeqClientForWorkspace(wreq.workspaceOwnerId);
  } catch {
    return void res.status(422).json({ state: "invalid", configured: false, items: [], total: 0, limit: 0, offset: 0, error: "Wafeq credentials could not be verified" });
  }
  if (!connection) return void res.status(503).json({ state: "not_configured", configured: false, items: [], total: 0, limit: 0, offset: 0, error: "Wafeq connection is not configured" });
  if (connection.row.status === "invalid") {
    return void res.status(422).json({ state: "invalid", configured: false, items: [], total: 0, limit: 0, offset: 0, error: "Wafeq credentials could not be verified" });
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const keyword = typeof req.query.q === "string" ? req.query.q.trim() : typeof req.query.search === "string" ? req.query.search.trim() : undefined;
  try {
    const values = kind === "suppliers"
      ? await connection.client.listSuppliers({ keyword })
      : kind === "accounts"
        ? await connection.client.listAccounts()
        : await connection.client.listTaxRates();
    const filteredValues = kind === "accounts" && keyword
      ? values.filter((account) => {
          const needle = keyword.toLocaleLowerCase();
          const candidate = account as { account_code?: unknown; name_en?: unknown };
          return [candidate.account_code, candidate.name_en].some((value) =>
            typeof value === "string" && value.toLocaleLowerCase().includes(needle),
          );
        })
      : values;
    const page = filteredValues.slice(offset, offset + limit);
    if (connection.row.status !== "configured") {
      await db.query(
        `UPDATE wafeq_connections
            SET status='configured',last_verified_at=now(),last_error=NULL,last_error_at=NULL,updated_at=now()
          WHERE workspace_owner_id=$1`,
        [wreq.workspaceOwnerId],
      );
    }
    return void res.json({
      state: "configured",
      configured: true,
      items: page,
      [kind === "tax-rates" ? "tax_rates" : kind]: page,
      total: filteredValues.length,
      limit,
      offset,
      has_more: offset + limit < filteredValues.length,
    });
  } catch (error) {
    const failure = wafeqFailureState(error);
    await db.query(`UPDATE wafeq_connections SET status=$1,last_error=$2,last_error_at=now(),updated_at=now() WHERE workspace_owner_id=$3`, [failure.status, failure.message, wreq.workspaceOwnerId]);
    return void res.status(failure.httpStatus).json({ state: failure.status, configured: false, items: [], total: 0, limit, offset, error: failure.message });
  }
}

router.get(["/finance/invoice-review/wafeq/suppliers", "/finance/wafeq/suppliers"], async (req, res) => wafeqLookup(req, res, "suppliers"));
router.get(["/finance/invoice-review/wafeq/accounts", "/finance/wafeq/accounts"], async (req, res) => wafeqLookup(req, res, "accounts"));
router.get(["/finance/invoice-review/wafeq/tax-rates", "/finance/wafeq/tax-rates", "/finance/invoice-review/wafeq/taxes"], async (req, res) => wafeqLookup(req, res, "tax-rates"));

router.get("/finance/invoice-review/audit-approved-to-odoo", auditApprovedToOdoo);

router.get("/finance/suppliers/search", async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanAccess(wreq)) return void res.status(403).json({ error: "Finance access required" });
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const entityId = Number(req.query.entity_id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const result = await db.query(
    `SELECT s.id,s.name,s.display_name,s.tax_number,s.odoo_partner_id
       FROM suppliers s
      WHERE s.workspace_owner_id=$1
        AND s.is_archived=false
        AND (
          $2=''
          OR s.name ILIKE '%' || $2 || '%'
          OR s.display_name ILIKE '%' || $2 || '%'
          OR s.tax_number ILIKE '%' || $2 || '%'
           OR upper(regexp_replace(coalesce(s.name,''), '[^[:alnum:]]', '', 'g'))
                LIKE '%' || upper(regexp_replace($2, '[^[:alnum:]]', '', 'g')) || '%'
           OR upper(regexp_replace(coalesce(s.display_name,''), '[^[:alnum:]]', '', 'g'))
                LIKE '%' || upper(regexp_replace($2, '[^[:alnum:]]', '', 'g')) || '%'
           OR upper(regexp_replace(coalesce(s.tax_number,''), '[^[:alnum:]]', '', 'g'))
                LIKE '%' || upper(regexp_replace($2, '[^[:alnum:]]', '', 'g')) || '%'
          OR EXISTS (
            SELECT 1 FROM ai_invoice_imports h
             WHERE h.workspace_owner_id=s.workspace_owner_id
               AND h.supplier_id=s.id
               AND ($3::integer IS NULL OR h.entity_id=$3)
               AND h.vendor_name ILIKE '%' || $2 || '%'
          )
        )
      ORDER BY
        CASE WHEN upper(regexp_replace(coalesce(s.display_name,s.name), '[^[:alnum:]]', '', 'g'))
                    = upper(regexp_replace($2, '[^[:alnum:]]', '', 'g')) THEN 0 ELSE 1 END,
        CASE WHEN s.tax_number IS NOT NULL AND upper(regexp_replace(s.tax_number, '[^[:alnum:]]', '', 'g'))
                    = upper(regexp_replace($2, '[^[:alnum:]]', '', 'g')) THEN 0 ELSE 1 END,
        COALESCE(s.display_name,s.name),s.id
      LIMIT $4`,
    [wreq.workspaceOwnerId, query, Number.isInteger(entityId) && entityId > 0 ? entityId : null, limit],
  );
  res.json({ suppliers: result.rows, total: result.rows.length });
});

router.get("/finance/invoice-review/:id", async (req, res) => {
  const wreq = workspace(req); if (!reviewCanAccess(wreq)) return void res.status(403).json({ error: "Finance access required" });
  const requestedInvoiceId = Number(req.params.id);
  const invoice = await reviewImport(req, res, requestedInvoiceId); if (!invoice) return;
  const [issues, acknowledgements, entity, audit, edits, resolvedSupplier] = await Promise.all([
    db.query(`SELECT * FROM ai_invoice_import_issues WHERE import_id=$1 AND resolved_at IS NULL ORDER BY blocking DESC,id`, [invoice.id]),
    db.query(`SELECT issue_key,version,acknowledged_by,acknowledged_at FROM ai_invoice_import_acknowledgements WHERE import_id=$1`, [invoice.id]),
    db.query<InvoiceRoutingEntity>(`SELECT legal_name,display_name,country,accounting_system FROM finance_entities WHERE id=$1`, [invoice.entity_id]),
    db.query(`SELECT event_type,created_at FROM ai_invoice_import_audit_events WHERE import_id=$1 ORDER BY created_at DESC LIMIT 10`, [invoice.id]),
    db.query(`SELECT changed_by,changed_at,before_values,after_values FROM ai_invoice_import_edits WHERE import_id=$1 ORDER BY changed_at DESC`, [invoice.id]),
    invoice.supplier_id
      ? db.query<{ id: number; name: string; display_name: string | null; tax_number: string | null; country: string | null }>(
          `SELECT id,name,display_name,tax_number,country FROM suppliers WHERE id=$1 AND workspace_owner_id=$2 AND is_archived=false`,
          [invoice.supplier_id, wreq.workspaceOwnerId],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  let effectiveResolvedSupplier = resolvedSupplier.rows[0] ?? null;
  if (!effectiveResolvedSupplier && invoice.vendor_name) {
    const historical = await db.query<{ id: number; name: string; display_name: string | null; tax_number: string | null; country: string | null }>(
      `SELECT s.id,s.name,s.display_name,s.tax_number,s.country
         FROM suppliers s
         JOIN ai_invoice_imports h
           ON h.supplier_id=s.id
          AND h.workspace_owner_id=s.workspace_owner_id
        WHERE s.workspace_owner_id=$1
          AND s.is_archived=false
          AND h.entity_id=$2
          AND h.id<>$3
          AND upper(regexp_replace(coalesce(h.vendor_name,''), '[^[:alnum:]]', '', 'g'))
              = upper(regexp_replace($4, '[^[:alnum:]]', '', 'g'))
          AND (h.provider_sync_status='succeeded' OR h.sync_status='succeeded')
           GROUP BY s.id,s.name,s.display_name,s.tax_number,s.country
        ORDER BY max(h.updated_at) DESC
        LIMIT 2`,
      [wreq.workspaceOwnerId, invoice.entity_id, invoice.id, invoice.vendor_name],
    );
    if (historical.rows.length === 1) effectiveResolvedSupplier = historical.rows[0];
  }
  const candidates = invoice.vendor_name ? await db.query(
    `SELECT id,name,display_name,tax_number,country FROM suppliers
      WHERE workspace_owner_id=$1 AND is_archived=false
      ORDER BY CASE
        WHEN upper(regexp_replace(coalesce(display_name,name), '[^[:alnum:]]', '', 'g'))
           = upper(regexp_replace($2, '[^[:alnum:]]', '', 'g')) THEN 0 ELSE 1 END,
        COALESCE(display_name,name),id LIMIT 50`,
    [wreq.workspaceOwnerId, invoice.vendor_name],
  ) : { rows: [] };
  const resolvedDestination = entity.rows[0] ? resolvedInvoiceDestination(invoice, entity.rows[0]) : null;
  const matchingAttempt = resolvedDestination === "odoo" && invoice.odoo_bill_id
    ? await db.query(
      `SELECT 1 FROM ai_invoice_import_sync_attempts
        WHERE import_id=$1 AND destination='odoo' AND status='succeeded' AND verified_at IS NOT NULL AND external_reference=$2
        LIMIT 1`,
      [invoice.id, invoice.odoo_bill_id],
    )
    : { rowCount: 0 };
  const reviewInvoice = {
    ...invoice,
    supplier_id: invoice.supplier_id ?? effectiveResolvedSupplier?.id ?? null,
    sync_status: effectiveInvoiceSyncStatus(invoice, resolvedDestination, !!matchingAttempt.rowCount),
  };
  const reviewValidation = await validateReviewInvoice(reviewInvoice, wreq.workspaceOwnerId, resolvedDestination ?? undefined);
  res.json({ requested_invoice_id: requestedInvoiceId, canonical_invoice_id: invoice.id,
    invoice: { ...reviewInvoice, resolved_accounting_destination: resolvedDestination }, validation: reviewValidation, reconciliation: reviewValidation.reconciliation, issues: issues.rows, acknowledgements: acknowledgements.rows,
    source_document: { available: !!invoice.pdf_storage_path, url: invoice.pdf_storage_path ? `/api/finance/invoice-review/${invoice.id}/source` : null, content_type: invoice.source_metadata?.mime_type ?? null, page_count: invoice.source_metadata?.page_count ?? null, filename: invoice.source_metadata?.filename ?? invoice.original_filename, byte_size: invoice.source_metadata?.byte_size ?? null },
    extraction_provenance: { coordinates_available: invoice.extraction_evidence?.coordinates_available === true, fields: invoice.extraction_evidence?.fields ?? {}, lines: invoice.extraction_evidence?.lines ?? [], coordinate_space: "normalized_0_to_1" },
    permissions: { can_edit: reviewCanEdit(wreq), can_approve: reviewCanApprove(wreq), can_sync: reviewCanApprove(wreq), can_reject: reviewCanEdit(wreq), can_delete: isOwner(wreq), can_upload_source: reviewCanUploadSource(wreq) },
    entity: entity.rows[0] ?? null, destination: { ...(entity.rows[0] ?? {}), accounting_system: resolvedDestination }, resolved_accounting_destination: resolvedDestination,
    resolved_supplier: effectiveResolvedSupplier, supplier_candidates: candidates.rows, candidates: candidates.rows, audit: audit.rows, audit_summary: audit.rows,
    edit_history: edits.rows });
});

router.post("/finance/invoice-review/:id/validate", async (req, res) => {
  const wreq = workspace(req); if (!reviewCanEdit(wreq)) return void res.status(403).json({ error: "Invoice review edit permission required" });
  const invoice = await reviewImport(req, res, Number(req.params.id)); if (!invoice) return;
  const validation = await validateReviewInvoice(invoice, wreq.workspaceOwnerId, (await reviewProvider(invoice, wreq.workspaceOwnerId)) ?? undefined);
  for (const issue of validation.issues) await db.query(
    `INSERT INTO ai_invoice_import_issues(import_id,issue_key,severity,message,field,blocking,resolved_at,resolved_by,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,now()) ON CONFLICT(import_id,issue_key) DO UPDATE SET severity=EXCLUDED.severity,message=EXCLUDED.message,field=EXCLUDED.field,blocking=EXCLUDED.blocking,resolved_at=NULL,resolved_by=NULL,updated_at=now()`,
    [invoice.id, issue.issue_key, issue.severity, issue.message, issue.field ?? null, issue.blocking]);
  await db.query(`UPDATE ai_invoice_import_issues SET resolved_at=now(),resolved_by=$2 WHERE import_id=$1 AND issue_key != ALL($3::text[]) AND resolved_at IS NULL`,
    [invoice.id, wreq.userId, validation.issues.map((x) => x.issue_key)]);
  res.json(validation);
});

router.patch("/finance/invoice-review/:id/destination", async (req, res) => {
  const wreq = workspace(req); if (!reviewCanEdit(wreq)) return void res.status(403).json({ error: "Invoice review edit permission required" });
  const invoice = await reviewImport(req, res, Number(req.params.id)); if (!invoice) return;
  const body = req.body as Record<string, unknown>;
  const version = validVersion(body);
  const destination = normalizeInvoiceDestination(body.destination);
  if (version !== invoice.review_version || destination === undefined) {
    return void res.status(400).json({ error: "Valid version and destination are required" });
  }
  if (invoice.sync_status === "pending" || invoice.sync_status === "in_progress" || invoice.sync_status === "succeeded" || invoice.provider_sync_status === "succeeded") {
    return void res.status(409).json({ error: "The accounting destination cannot be changed after sync has started" });
  }
  const result = await db.query<InvoiceImportRow>(
    `UPDATE ai_invoice_imports
        SET accounting_destination=$1,review_version=review_version+1,updated_at=now()
      WHERE id=$2 AND workspace_owner_id=$3 AND review_version=$4
      RETURNING *`,
    [destination, invoice.id, wreq.workspaceOwnerId, version],
  );
  if (!result.rowCount) return void res.status(409).json({ error: "Invoice was changed by another reviewer" });
  const updated = result.rows[0];
  const entity = await db.query<InvoiceRoutingEntity>(
    `SELECT accounting_system,country,legal_name,display_name FROM finance_entities WHERE id=$1 AND workspace_owner_id=$2`,
    [updated.entity_id, wreq.workspaceOwnerId],
  );
  const resolved = entity.rows[0] ? resolvedInvoiceDestination(updated, entity.rows[0]) : null;
  await auditReview(invoice.id, wreq.userId, "destination_updated", { version: version + 1, destination: resolved ?? "undecided" });
  return void res.json({
    invoice: { ...updated, resolved_accounting_destination: resolved },
    validation: await validateReviewInvoice(updated, wreq.workspaceOwnerId, resolved ?? undefined),
    resolved_accounting_destination: resolved,
  });
});

router.patch("/finance/invoice-review/:id/draft", async (req, res) => {
  const wreq = workspace(req); if (!reviewCanEdit(wreq)) return void res.status(403).json({ error: "Invoice review edit permission required" });
  const invoice = await reviewImport(req, res, Number(req.params.id)); if (!invoice) return;
  const provider = await reviewProvider(invoice, wreq.workspaceOwnerId);
  const body = req.body as Record<string, unknown>; const version = validVersion(body);
  if (invoice.sync_status === "pending" || invoice.sync_status === "in_progress") return void res.status(409).json({ error: "Invoice cannot be edited while sync is pending or in progress" });
  if (invoice.provider_sync_status === "succeeded") return void res.status(409).json({ error: "Invoice cannot be edited until its completed accounting sync is mirrored locally" });
  if (version !== invoice.review_version) return void res.status(409).json({ error: "Invoice was changed by another reviewer", version: invoice.review_version });
  if ("supplier_id" in body && body.supplier_id != null) {
    const supplierId = Number(body.supplier_id);
    if (!Number.isInteger(supplierId) || !(await db.query(`SELECT 1 FROM suppliers WHERE id=$1 AND workspace_owner_id=$2 AND is_archived=false`, [supplierId, wreq.workspaceOwnerId])).rowCount) return void res.status(404).json({ error: "Supplier not found" });
  }
  const requestedDestination = "accounting_destination" in body ? normalizeInvoiceDestination(body.accounting_destination) : provider;
  if (requestedDestination === undefined) return void res.status(400).json({ error: "Invalid accounting destination" });
  const allowed = ["vendor_name","vendor_tax_number","vendor_address","invoice_number","invoice_date","due_date","currency","manual_accounting_reference","billing_country","subtotal","tax_amount","total_amount","supplier_id","wafeq_supplier_id","wafeq_account_id","wafeq_tax_id","line_items","accounting_destination"];
  const fields: string[] = []; const values: unknown[] = [];
  const optionalAccountingFields = new Set(["manual_accounting_reference", "wafeq_supplier_id", "wafeq_account_id", "wafeq_tax_id"]);
  const dateFields = new Set(["invoice_date", "due_date"]);
  const moneyFields = new Set(["subtotal", "tax_amount", "total_amount"]);
  for (const key of allowed) if (key in body) {
    let value = body[key];
    if (key === "line_items") {
      if (!Array.isArray(value)) return void res.status(400).json({ error: "Line items must be an array" });
      value = JSON.stringify(requestedDestination === "wafeq" ? normalizeWafeqLineItems(value) : value);
    }
    else if (key === "accounting_destination") value = requestedDestination;
    else if (dateFields.has(key)) {
      const raw = String(value ?? "").trim();
      if (!raw) value = null;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
        return void res.status(400).json({ error: `${key === "invoice_date" ? "Invoice date" : "Due date"} must be a valid date` });
      } else value = raw;
    }
    else if (moneyFields.has(key)) {
      if (value == null || String(value).trim() === "") value = null;
      else {
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 0) {
          return void res.status(400).json({ error: `${key.replaceAll("_", " ")} must be a non-negative number` });
        }
        value = amount;
      }
    }
    else if (key === "supplier_id") value = value == null || value === "" ? null : Number(value);
    else if (optionalAccountingFields.has(key)) value = typeof value === "string" && value.trim() ? value.trim() : null;
    values.push(value);
    fields.push(`${key}=$${values.length}`);
  }
  if (!fields.length) return void res.status(400).json({ error: "No editable fields provided" });
  values.push(invoice.id, wreq.workspaceOwnerId, version);
  const update = await db.query<InvoiceImportRow>(`WITH changed AS (
      UPDATE ai_invoice_imports SET ${fields.join(",")},review_status='needs_review',approved_at=NULL,approved_by=NULL,reviewed_snapshot=NULL,
        sync_status='not_requested',provider_sync_status='not_requested',
        supplier_confirmation=NULL,provider_sync_error=NULL,error_message=NULL,
        review_version=review_version+1,updated_at=now()
      WHERE id=$${values.length-2} AND workspace_owner_id=$${values.length-1} AND review_version=$${values.length} RETURNING *
    ), edit AS (
      INSERT INTO ai_invoice_import_edits(import_id,changed_by,before_values,after_values)
      SELECT id,$${values.length+1},$${values.length+2}::jsonb,to_jsonb(changed.*) FROM changed
    ) SELECT * FROM changed`, [...values, wreq.userId, JSON.stringify(reviewSnapshot(invoice))]);
  if (!update.rowCount) return void res.status(409).json({ error: "Invoice was changed by another reviewer" });
  await auditReview(invoice.id, wreq.userId, "draft_updated", { version: version + 1, fields: fields.length });
  const validation = await validateReviewInvoice(update.rows[0], wreq.workspaceOwnerId, requestedDestination ?? undefined);
  for (const issue of validation.issues) {
    await db.query(
      `INSERT INTO ai_invoice_import_issues(import_id,issue_key,severity,message,field,blocking,resolved_at,resolved_by,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,now())
       ON CONFLICT(import_id,issue_key) DO UPDATE
       SET severity=EXCLUDED.severity,message=EXCLUDED.message,field=EXCLUDED.field,
           blocking=EXCLUDED.blocking,resolved_at=NULL,resolved_by=NULL,updated_at=now()`,
      [invoice.id, issue.issue_key, issue.severity, issue.message, issue.field ?? null, issue.blocking],
    );
  }
  await db.query(
    `UPDATE ai_invoice_import_issues
        SET resolved_at=now(),resolved_by=$2,updated_at=now()
      WHERE import_id=$1 AND resolved_at IS NULL AND issue_key != ALL($3::text[])`,
    [invoice.id, wreq.userId, validation.issues.map((issue) => issue.issue_key)],
  );
  res.json({ invoice: update.rows[0], validation });
});

router.post("/finance/invoice-review/:id/acknowledge", async (req, res) => {
  const wreq = workspace(req); if (!reviewCanEdit(wreq)) return void res.status(403).json({ error: "Invoice review edit permission required" });
  const invoice = await reviewImport(req, res, Number(req.params.id)); if (!invoice) return;
  const body = req.body as Record<string, unknown>; const version = validVersion(body);
  if (version !== invoice.review_version || typeof body.issue_key !== "string") return void res.status(400).json({ error: "Valid version and issue_key are required" });
  const validation = await validateReviewInvoice(invoice, wreq.workspaceOwnerId, (await reviewProvider(invoice, wreq.workspaceOwnerId)) ?? undefined);
  const warning = validation.issues.find((issue) => issue.issue_key === body.issue_key && !issue.blocking && issue.severity !== "error");
  if (!warning) return void res.status(422).json({ error: "Only a current non-blocking warning can be acknowledged" });
  await db.query(`INSERT INTO ai_invoice_import_acknowledgements(import_id,issue_key,version,acknowledged_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [invoice.id, body.issue_key, version, wreq.userId]);
  await auditReview(invoice.id, wreq.userId, "warning_acknowledged", { issue_key: body.issue_key, version });
  res.json({ success: true });
});

router.post("/finance/invoice-review/:id/approve", async (req, res) => {
  const wreq = workspace(req); if (!reviewCanApprove(wreq)) return void res.status(403).json({ error: "Approval permission required" });
  const invoice = await reviewImport(req, res, Number(req.params.id)); if (!invoice) return;
  const body = req.body as Record<string, unknown>;
  if (body.sync === false) {
    const approval = await approveInvoiceOnly(invoice, wreq, validVersion(body));
    if (!approval.ok) return void res.status(approval.status).json(approval.body);
    return void res.json({
      invoice: approval.invoice,
      validation: approval.validation,
      sync: { status: "not_requested", destination: approval.provider ?? "undecided", deferred: true },
    });
  }
  const version = validVersion(req.body as Record<string, unknown>); if (version !== invoice.review_version) return void res.status(409).json({ error: "Invoice was changed by another reviewer" });
  if (invoice.review_status !== "needs_review" || !["not_requested", "failed"].includes(invoice.sync_status ?? "not_requested")) {
    return void res.status(409).json({ error: "Only an unsynced invoice awaiting review can be approved" });
  }
  try {
    if (!invoice.pdf_storage_path) throw new Error("missing source path");
    const sourceFile = await objectStorageService.getObjectEntityFile(invoice.pdf_storage_path);
    if (typeof sourceFile.exists === "function") {
      const [exists] = await sourceFile.exists();
      if (!exists) throw new Error("missing source object");
    }
  } catch {
    return void res.status(422).json({ error: "The authenticated source document is unavailable. Restore it before approval." });
  }
  const entityPreview = await db.query<InvoiceRoutingEntity>(
    `SELECT accounting_system,country,legal_name,display_name FROM finance_entities /* SELECT accounting_system FROM finance_entities */ WHERE id=$1 AND workspace_owner_id=$2`,
    [invoice.entity_id, wreq.workspaceOwnerId],
  );
  const provider = entityPreview.rows[0] ? resolvedInvoiceDestination(invoice, entityPreview.rows[0]) : null;
  if (provider === "wafeq") {
    const connection = await readWafeqConnection(wreq.workspaceOwnerId);
    if (!connection || connection.status !== "configured" || !connection.encrypted_api_key) {
      return void res.status(503).json({ error: "Wafeq connection is required before approval", state: "not_configured" });
    }
  }
  const safety = provider === "odoo"
    ? await validateOdooSyncSafety(invoice, wreq.workspaceOwnerId)
    : null;
  const effectiveInvoice = safety?.invoice ?? invoice;
  const effectiveVersion = effectiveInvoice.review_version ?? version;
  const validation = safety?.validation
    ?? await validateReviewInvoice(effectiveInvoice, wreq.workspaceOwnerId, provider ?? undefined);
  if (validation.issues.some((issue) => issue.blocking)) {
    return void res.status(422).json({
      error: "Resolve all blocking validation issues before approval",
      validation,
    });
  }
  const syncKey = typeof (req.body as Record<string, unknown>).idempotency_key === "string" ? String((req.body as Record<string, unknown>).idempotency_key).trim() : `approval:${effectiveInvoice.id}:${effectiveVersion}`;
  const startsExternalSync = provider === "odoo" || provider === "wafeq";
  const approvalParams = startsExternalSync
    ? [wreq.userId, JSON.stringify(reviewSnapshot(effectiveInvoice)), effectiveInvoice.id, effectiveVersion, syncKey, provider]
    : [wreq.userId, JSON.stringify(reviewSnapshot(effectiveInvoice)), effectiveInvoice.id, effectiveVersion];
  const update = await db.query<InvoiceImportRow & { attempt_id?: number }>(startsExternalSync ? `WITH approved AS (
      UPDATE ai_invoice_imports SET review_status='approved',approved_at=now(),approved_by=$1,reviewed_snapshot=$2,sync_status='pending',review_version=review_version+1,updated_at=now()
      WHERE id=$3 AND review_version=$4 AND review_status='needs_review' AND sync_status IN ('not_requested','failed') RETURNING *
    ), attempt AS (
      INSERT INTO ai_invoice_import_sync_attempts(import_id,idempotency_key,review_version,status,destination)
      SELECT id,$5,review_version,'pending',$6 FROM approved
      ON CONFLICT(import_id,idempotency_key) DO NOTHING RETURNING id
    ) SELECT approved.*,attempt.id attempt_id FROM approved CROSS JOIN attempt` : `UPDATE ai_invoice_imports
      SET review_status='approved',approved_at=now(),approved_by=$1,reviewed_snapshot=$2,sync_status='not_requested',review_version=review_version+1,updated_at=now()
      WHERE id=$3 AND review_version=$4 AND review_status='needs_review'
        AND sync_status IN ('not_requested','failed') AND superseded_by_import_id IS NULL
      RETURNING *,NULL::integer AS attempt_id`, approvalParams);
  if (!update.rowCount) return void res.status(409).json({ error: "Invoice was changed by another reviewer" });
  await auditReview(effectiveInvoice.id, wreq.userId, "approved", {
    version: effectiveVersion + 1,
    unresolved_validation_issues: validation.issues.map((issue) => ({
      issue_key: issue.issue_key,
      severity: issue.severity,
      blocking: issue.blocking,
    })),
  });
  const entityResult = await db.query<FinanceEntityRow>(`SELECT * FROM finance_entities WHERE id=$1 AND workspace_owner_id=$2`, [invoice.entity_id, wreq.workspaceOwnerId]);
  if (!entityResult.rows[0]) return void res.status(404).json({ error: "Finance entity not found" });
  if (!startsExternalSync || !provider || !update.rows[0].attempt_id) {
    return void res.json({
      invoice: { ...update.rows[0], resolved_accounting_destination: provider },
      validation,
      sync: { status: "not_requested", destination: provider ?? "undecided", deferred: true },
    });
  }
  const leaseToken = randomUUID();
  const lease = await db.query(`UPDATE ai_invoice_import_sync_attempts SET status='in_progress',lease_token=$1,lease_until=now()+interval '5 minutes' WHERE id=$2 AND status='pending'`, [leaseToken, update.rows[0].attempt_id]);
  if (!lease.rowCount) return void res.status(409).json({ error: "Sync attempt is already claimed" });
  const synced = provider === "odoo"
    ? await ensureInvoiceInOdoo(update.rows[0], entityResult.rows[0], {
      attemptId: update.rows[0].attempt_id,
      leaseToken,
      workspaceOwnerId: wreq.workspaceOwnerId,
      actorId: wreq.userId,
    })
    : await executeInvoiceSync(update.rows[0], entityResult.rows[0], provider, update.rows[0].attempt_id, leaseToken, wreq.workspaceOwnerId, wreq.userId);
   if (!synced.success) {
     if (synced.reason_code === "supplier_confirmation_required") {
       return void res.json({
         success: false,
         invoice: update.rows[0],
         validation,
         sync: {
           status: "needs_supplier_confirmation",
           idempotency_key: syncKey,
           supplier_candidates: synced.supplier_candidates ?? [],
         },
         supplier_confirmation: {
           vendor_name: update.rows[0].vendor_name,
           candidates: synced.supplier_candidates ?? [],
         },
       });
     }
     return void res.status(syncFailureStatus(synced.error)).json({
       success: false,
       invoice: update.rows[0],
       validation,
        sync: { status: "failed", idempotency_key: syncKey, external_reference: synced.provider_bill_id, reason_code: synced.reason_code, error: synced.error },
        reason_code: synced.reason_code,
       error: synced.error,
     });
   }
   res.json({ invoice: update.rows[0], validation, sync: { status: "succeeded", idempotency_key: syncKey, external_reference: synced.provider_bill_id, error: synced.error } });
});

router.post("/finance/invoice-review/approve-selected", async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanApprove(wreq)) return void res.status(403).json({ error: "Approval permission required" });
  const body = req.body as Record<string, unknown>;
  const rawIds = Array.isArray(body.invoice_ids) ? body.invoice_ids : [];
  const ids = [...new Set(rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0 || ids.length > 100) {
    return void res.status(400).json({ error: "Choose between 1 and 100 invoices to approve" });
  }
  const rawVersions = body.versions && typeof body.versions === "object" && !Array.isArray(body.versions)
    ? body.versions as Record<string, unknown>
    : {};
  // Queue approval is deliberately database-only. In particular, do not call
  // approveInvoiceOnly here: that single-invoice path performs source-object
  // checks and Odoo safety/provider work that has no place in a bulk review
  // action. Capture the rows the browser actually reviewed before the bounded
  // merge pass so only transitions produced by this request can translate a
  // selected source version to the canonical row.
  const preMergeRows = await db.query<Pick<InvoiceImportRow, "id" | "review_version" | "superseded_by_import_id">>(
    `SELECT id,review_version,superseded_by_import_id FROM ai_invoice_imports
      WHERE workspace_owner_id=$1 AND id=ANY($2::int[])`,
    [wreq.workspaceOwnerId, ids],
  );
  const preMergeState = new Map(preMergeRows.rows.map((row) => [row.id, row]));
  await mergeInvoiceGroupsIfSafe(wreq.workspaceOwnerId, { seedIds: ids, maxGroups: ids.length });
  const requestedRows = await db.query<InvoiceImportRow>(
     `WITH RECURSIVE chain AS (
       SELECT i.*,ARRAY[i.id]::int[] AS resolution_path,0 AS resolution_depth
         FROM ai_invoice_imports i
        WHERE i.workspace_owner_id=$1 AND i.id=ANY($2::int[])
       UNION ALL
       SELECT next_i.*,c.resolution_path || next_i.id,c.resolution_depth + 1
         FROM ai_invoice_imports next_i
        JOIN chain c ON next_i.id=c.superseded_by_import_id
       WHERE next_i.workspace_owner_id=$1
         AND c.resolution_depth < 11
         AND NOT next_i.id=ANY(c.resolution_path)
     )
     SELECT DISTINCT ON (i.id) i.* FROM chain i`,
    [wreq.workspaceOwnerId, ids],
  );
  const rowsById = new Map(requestedRows.rows.map((row) => [row.id, row]));
  const resolveCanonicalRow = (row: InvoiceImportRow): InvoiceImportRow | undefined => {
    let current = row;
    const visited = new Set<number>();
    while (current.superseded_by_import_id) {
      if (current.superseded_by_import_id === current.id) return undefined;
      if (visited.has(current.id)) return undefined;
      visited.add(current.id);
      const next = rowsById.get(current.superseded_by_import_id);
      if (!next) return undefined;
      current = next;
    }
    return current;
  };
  const canonicalRows = [...new Map(requestedRows.rows
    .map(resolveCanonicalRow)
    .filter((row): row is InvoiceImportRow => !!row)
    .map((row) => [row.id, row])).values()];
  const entityIds = [...new Set(canonicalRows.map((row) => row.entity_id).filter((id): id is number => Number.isInteger(id)))];
  const entitiesResult = entityIds.length
    ? await db.query<FinanceEntityRow>(
      `SELECT * FROM finance_entities WHERE workspace_owner_id=$1 AND id=ANY($2::int[])`,
      [wreq.workspaceOwnerId, entityIds],
    )
    : { rows: [] as FinanceEntityRow[] };
  const entitiesById = new Map(entitiesResult.rows.map((entity) => [entity.id, entity]));
  const settingsResult = entityIds.length
    ? await db.query<{ entity_id: number; settings_json: Record<string, unknown> }>(
      `SELECT entity_id,settings_json FROM ai_invoice_import_settings WHERE workspace_owner_id=$1 AND entity_id=ANY($2::int[])`,
      [wreq.workspaceOwnerId, entityIds],
    )
    : { rows: [] as Array<{ entity_id: number; settings_json: Record<string, unknown> }> };
  const settingsByEntity = new Map(settingsResult.rows.map((row) => [row.entity_id, row.settings_json ?? {}]));
  const canonicalIds = canonicalRows.map((row) => row.id);
  const issuesResult = canonicalIds.length
    ? await db.query<{ import_id: number; issue_key: string; blocking: boolean; resolved_at: Date | null }>(
      `SELECT import_id,issue_key,blocking,resolved_at FROM ai_invoice_import_issues WHERE import_id=ANY($1::int[])`,
      [canonicalIds],
    )
    : { rows: [] as Array<{ import_id: number; issue_key: string; blocking: boolean; resolved_at: Date | null }> };
  const acknowledgementsResult = canonicalIds.length
    ? await db.query<{ import_id: number; issue_key: string; version: number }>(
      `SELECT import_id,issue_key,version FROM ai_invoice_import_acknowledgements WHERE import_id=ANY($1::int[])`,
      [canonicalIds],
    )
    : { rows: [] as Array<{ import_id: number; issue_key: string; version: number }> };
  const acknowledged = new Set(acknowledgementsResult.rows.map((row) => `${row.import_id}|${row.issue_key}|${row.version}`));
  const issuesByInvoice = new Map<number, typeof issuesResult.rows>();
  for (const issue of issuesResult.rows) issuesByInvoice.set(issue.import_id, [...(issuesByInvoice.get(issue.import_id) ?? []), issue]);
  const results: Array<{
    invoice_id: number;
    status: "approved" | "blocked" | "skipped";
    reason?: string;
    canonical_invoice_id?: number;
    review_version?: number;
  }> = [];
  const approvals: Array<{ id: number; version: number; snapshot: Record<string, unknown>; issues: unknown[] }> = [];
  for (const id of ids) {
    const requested = requestedRows.rows.find((row) => row.id === id);
    if (!requested) {
      results.push({ invoice_id: id, status: "skipped", reason: "Invoice not found" });
      continue;
    }
    const canonical = resolveCanonicalRow(requested);
    if (!canonical) {
      results.push({ invoice_id: id, status: "skipped", reason: "Canonical invoice not found" });
      continue;
    }
    const canonicalId = canonical.id;
    if (canonical.review_status !== "needs_review" || !["not_requested", "failed"].includes(canonical.sync_status ?? "not_requested")) {
      results.push({ invoice_id: id, status: "skipped", reason: "Only an unsynced invoice awaiting review can be approved", canonical_invoice_id: canonicalId });
      continue;
    }
    const suppliedVersion = validVersion({ version: rawVersions[String(id)] });
    const reviewedState = preMergeState.get(id);
    if (suppliedVersion === null || !reviewedState || suppliedVersion !== reviewedState.review_version) {
      results.push({ invoice_id: id, status: "skipped", reason: "Invoice was changed by another reviewer", canonical_invoice_id: canonicalId });
      continue;
    }
    const mergedSourceIds = Array.isArray(canonical.source_metadata?.merged_source_ids)
      ? canonical.source_metadata.merged_source_ids.map(Number)
      : [];
    const transitionedByMerge = (!reviewedState.superseded_by_import_id && requested.id !== canonical.id)
      || (mergedSourceIds.includes(requested.id) && canonical.review_version === suppliedVersion + 1);
    if (requested.id !== canonical.id && !transitionedByMerge) {
      results.push({ invoice_id: id, status: "skipped", reason: "Invoice was already superseded; review the canonical invoice", canonical_invoice_id: canonicalId });
      continue;
    }
    const version = transitionedByMerge
      ? canonical.review_version
      : suppliedVersion;
    if (version !== canonical.review_version) {
      results.push({ invoice_id: id, status: "skipped", reason: "Invoice was changed by another reviewer", canonical_invoice_id: canonicalId });
      continue;
    }
    if (!canonical.pdf_storage_path) {
      results.push({ invoice_id: id, status: "blocked", reason: "The authenticated source document is unavailable. Restore it before approval.", canonical_invoice_id: canonicalId });
      continue;
    }
    const entity = entitiesById.get(canonical.entity_id);
    if (!entity) {
      results.push({ invoice_id: id, status: "skipped", reason: "Finance entity not found", canonical_invoice_id: canonicalId });
      continue;
    }
    const settings = settingsByEntity.get(canonical.entity_id) ?? {};
    const toleranceValue = Number(settings.total_line_tolerance ?? settings.reconciliation_tolerance ?? .01);
    const tolerance = Number.isFinite(toleranceValue) && toleranceValue >= 0 ? toleranceValue : .01;
    const validation = validateInvoice(canonical, tolerance, { provider: "undecided" });
    const storedBlocking = (issuesByInvoice.get(canonicalId) ?? []).some((issue) =>
      issue.blocking && !issue.resolved_at && !acknowledged.has(`${canonicalId}|${issue.issue_key}|${canonical.review_version}`));
    const blockingIssue = validation.issues.find((issue) => issue.blocking)
      ?? (storedBlocking ? { message: "Resolve all blocking validation issues before approval" } : undefined);
    if (blockingIssue) {
      results.push({ invoice_id: id, status: "blocked", reason: blockingIssue.message, canonical_invoice_id: canonicalId });
      continue;
    }
    if (approvals.some((approval) => approval.id === canonicalId)) {
      results.push({ invoice_id: id, status: "skipped", reason: "Canonical invoice already included", canonical_invoice_id: canonicalId });
      continue;
    }
    approvals.push({ id: canonicalId, version: canonical.review_version!, snapshot: reviewSnapshot(canonical), issues: validation.issues });
    results.push({ invoice_id: id, status: "approved", canonical_invoice_id: canonicalId, review_version: canonical.review_version! + 1 });
  }
  if (approvals.length) {
    const approvalPayload = approvals.map((approval) => ({
      id: approval.id,
      version: approval.version,
      snapshot: approval.snapshot,
    }));
    const updated = await db.query<{ id: number; review_version: number }>(
      `WITH input AS (
         SELECT id,version,snapshot
           FROM jsonb_to_recordset($2::jsonb) AS x(id int,version int,snapshot jsonb)
       ), approved AS (
         UPDATE ai_invoice_imports i
            SET review_status='approved',approved_at=now(),approved_by=$1,
                reviewed_snapshot=input.snapshot,sync_status='not_requested',
                review_version=i.review_version+1,updated_at=now()
           FROM input
          WHERE i.id=input.id AND i.workspace_owner_id=$3
            AND i.review_version=input.version
            AND i.review_status='needs_review'
            AND i.sync_status IN ('not_requested','failed')
          RETURNING i.id,i.review_version
       ), audited AS (
         INSERT INTO ai_invoice_import_audit_events(import_id,actor_id,event_type,details)
         SELECT id,$1,'approved',jsonb_build_object('version',review_version)
           FROM approved
         RETURNING import_id
       )
       SELECT approved.id,approved.review_version
         FROM approved JOIN audited ON audited.import_id=approved.id`,
      [wreq.userId, JSON.stringify(approvalPayload), wreq.workspaceOwnerId],
    );
    const updatedIds = new Set(updated.rows.map((row) => row.id));
    for (const result of results) {
      if (result.status === "approved" && result.canonical_invoice_id && !updatedIds.has(result.canonical_invoice_id)) {
        result.status = "skipped";
        result.reason = "Invoice was changed by another reviewer";
        delete result.review_version;
      }
    }
  }
  const approved = results.filter((result) => result.status === "approved").length;
  const blocked = results.filter((result) => result.status === "blocked").length;
  res.json({
    success: blocked === 0 && results.every((result) => result.status === "approved"),
    approved,
    blocked,
    skipped: results.length - approved - blocked,
    results,
  });
});

router.post("/finance/invoice-review/:id/reject", async (req, res) => {
  const wreq = workspace(req); if (!reviewCanEdit(wreq)) return void res.status(403).json({ error: "Invoice review edit permission required" });
  const invoice = await reviewImport(req, res, Number(req.params.id)); if (!invoice) return;
  const body = req.body as Record<string, unknown>; const version = validVersion(body);
  if (version !== invoice.review_version || typeof body.reason !== "string" || !body.reason.trim()) return void res.status(400).json({ error: "Valid version and rejection reason are required" });
  const result = await db.query(`UPDATE ai_invoice_imports SET review_status='rejected',rejected_at=now(),rejected_by=$1,rejection_reason=$2,review_version=review_version+1 WHERE id=$3 AND review_version=$4`, [wreq.userId, body.reason.trim(), invoice.id, version]);
  if (!result.rowCount) return void res.status(409).json({ error: "Invoice was changed by another reviewer" });
  await auditReview(invoice.id, wreq.userId, "rejected", { version: version + 1 }); res.json({ success: true });
});

type SupplierConfirmationRetryResult =
  | { ok: true; outcome: InvoiceSyncOutcome }
  | { ok: false; status: number; error: string; outcome?: InvoiceSyncOutcome };

async function confirmSupplierAndRetry(
  invoice: InvoiceImportRow,
  providerSupplierId: number,
  wreq: ReturnType<typeof workspace>,
  candidateOverride?: {
    id: number;
    name: string;
    display_name?: string | null;
    tax_number?: string | null;
    score?: number;
  },
): Promise<SupplierConfirmationRetryResult> {
  const candidates = invoice.supplier_confirmation?.candidates ?? [];
  const candidate = candidateOverride ?? candidates.find((item) => item.id === providerSupplierId);
  if (!Number.isInteger(providerSupplierId) || providerSupplierId <= 0 || !candidate) {
    return { ok: false, status: 400, error: "Choose one of the listed Odoo suppliers" };
  }
  if (invoice.review_status !== "approved" || invoice.sync_status !== "needs_supplier_confirmation") {
    return { ok: false, status: 409, error: "This invoice is not waiting for supplier confirmation" };
  }

  let linkedSupplierId = invoice.supplier_id;
  if (linkedSupplierId != null) {
    const mapping = await db.query<{ id: number }>(
      `UPDATE suppliers
          SET odoo_partner_id=$1,updated_at=now()
        WHERE id=$2 AND workspace_owner_id=$3 AND is_archived=false
          AND (odoo_partner_id IS NULL OR odoo_partner_id=$1)
        RETURNING id`,
      [providerSupplierId, linkedSupplierId, wreq.workspaceOwnerId],
    );
    if (!mapping.rowCount) {
      return { ok: false, status: 409, error: "This workspace supplier is already mapped to a different Odoo supplier" };
    }
  } else {
    try {
      linkedSupplierId = await linkImportedInvoiceToVerifiedOdooSupplier(
        invoice.id,
        wreq.workspaceOwnerId,
        {
          id: providerSupplierId,
          name: candidate.name,
          taxNumber: candidate.tax_number ?? null,
        },
      );
    } catch (error) {
      logger.warn({ err: error, importId: invoice.id }, "finance: could not persist selected Odoo supplier");
      return { ok: false, status: 409, error: "The selected Odoo supplier could not be saved for this workspace" };
    }
  }

  await db.query(
    `UPDATE ai_invoice_imports
        SET supplier_id=$1,supplier_confirmation=NULL,provider_sync_error=NULL,error_message=NULL,updated_at=now()
      WHERE id=$2 AND workspace_owner_id=$3 AND sync_status='needs_supplier_confirmation'`,
    [linkedSupplierId, invoice.id, wreq.workspaceOwnerId],
  );
  const retryInvoice: InvoiceImportRow = {
    ...invoice,
    supplier_id: linkedSupplierId,
    supplier_confirmation: null,
    reviewed_snapshot: {
      ...(((invoice as Record<string, unknown>).reviewed_snapshot ?? reviewSnapshot(invoice)) as Record<string, unknown>),
      supplier_id: linkedSupplierId,
      odoo_partner_id: providerSupplierId,
      partner_id: providerSupplierId,
    },
  };
  const claimed = await claimInvoiceSyncAttempt(retryInvoice, "odoo", wreq.workspaceOwnerId, {
    idempotencyKey: `supplier-confirmation:${invoice.id}:${invoice.review_version ?? 1}:${randomUUID()}`,
    requireApproved: true,
  });
  if (!claimed) return { ok: false, status: 409, error: "This invoice is already being synced" };
  const entityResult = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE id=$1 AND workspace_owner_id=$2`,
    [invoice.entity_id, wreq.workspaceOwnerId],
  );
  const entity = entityResult.rows[0];
  if (!entity) return { ok: false, status: 404, error: "Finance entity not found" };

  const outcome = await ensureInvoiceInOdoo(retryInvoice, entity, {
    attemptId: claimed.attemptId,
    leaseToken: claimed.leaseToken,
    workspaceOwnerId: wreq.workspaceOwnerId,
    actorId: wreq.userId,
  });
  return { ok: true, outcome };
}

router.post("/finance/invoice-review/:id/confirm-supplier", async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanApprove(wreq)) return void res.status(403).json({ error: "Approval permission required" });
  const invoice = await reviewImport(req, res, Number(req.params.id));
  if (!invoice) return;

  const providerSupplierId = Number((req.body as Record<string, unknown>).provider_supplier_id);
  const result = await confirmSupplierAndRetry(invoice, providerSupplierId, wreq);
  if (!result.ok) return void res.status(result.status).json({ error: result.error });
  const outcome = result.outcome;
  if (!outcome.success) {
    if (outcome.reason_code === "supplier_confirmation_required") {
      return void res.json({
        success: false,
        needs_supplier_confirmation: true,
        supplier_candidates: outcome.supplier_candidates ?? [],
      });
    }
    return void res.status(syncFailureStatus(outcome.error)).json({ success: false, reason_code: outcome.reason_code, error: outcome.error ?? "Odoo sync failed" });
  }
  return void res.json({
    success: true,
    bill_id: outcome.provider_bill_id,
    bill_url: outcome.provider_bill_url,
    outcome: outcome.outcome ?? "created",
  });
});

/**
 * Explicitly create/reuse an Odoo supplier for a no-match confirmation and
 * immediately retry through the same canonical invoice sync path. The server
 * requires the confirmation flag so this cannot become an implicit fuzzy-match
 * or auto-merge operation.
 */
router.post("/finance/invoice-review/:id/create-odoo-supplier", async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanApprove(wreq)) return void res.status(403).json({ error: "Approval permission required" });
  const invoice = await reviewImport(req, res, Number(req.params.id));
  if (!invoice) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.confirm !== true) return void res.status(400).json({ error: "Explicit supplier creation confirmation is required" });
  if (invoice.review_status !== "approved" || invoice.sync_status !== "needs_supplier_confirmation") {
    return void res.status(409).json({ error: "This invoice is not waiting for a new supplier confirmation" });
  }
  const candidates = invoice.supplier_confirmation?.candidates ?? [];
  if (candidates.length > 0) {
    return void res.status(409).json({ error: "Choose one of the existing Odoo suppliers instead of creating a new one", candidates });
  }

  const requestedSupplierId = Number(body.supplier_id);
  const localSupplier = Number.isInteger(requestedSupplierId) && requestedSupplierId > 0
    ? await db.query<{ id: number; name: string; display_name: string | null; tax_number: string | null }>(
      `SELECT id,name,display_name,tax_number
         FROM suppliers
        WHERE id=$1 AND workspace_owner_id=$2 AND is_archived=false`,
      [requestedSupplierId, wreq.workspaceOwnerId],
    )
    : { rows: [] };
  if (Number.isInteger(requestedSupplierId) && requestedSupplierId > 0 && !localSupplier.rows[0]) {
    return void res.status(404).json({ error: "Workspace supplier not found" });
  }
  const supplierName = String(body.name ?? localSupplier.rows[0]?.display_name ?? localSupplier.rows[0]?.name ?? invoice.vendor_name ?? "").trim();
  const supplierAddress = String(body.address ?? invoice.vendor_address ?? "").trim() || null;
  const supplierTaxNumber = String(body.tax_number ?? localSupplier.rows[0]?.tax_number ?? invoice.vendor_tax_number ?? "").trim() || null;
  const countryCode = String(body.country ?? invoice.billing_country ?? "").trim().toUpperCase() || null;
  if (!supplierName) return void res.status(400).json({ error: "A reviewed supplier name is required" });

  const entityResult = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE id=$1 AND workspace_owner_id=$2`,
    [invoice.entity_id, wreq.workspaceOwnerId],
  );
  const entity = entityResult.rows[0];
  if (!entity) return void res.status(404).json({ error: "Finance entity not found" });

  let supplier: Awaited<ReturnType<typeof ensureOdooSupplier>>;
  try {
    supplier = await ensureOdooSupplier(entity, {
      name: supplierName,
      address: supplierAddress,
      countryCode,
      taxNumber: supplierTaxNumber,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Odoo supplier could not be created";
    logger.warn({ err: error, importId: invoice.id }, "finance: explicit Odoo supplier creation failed");
    return void res.status(502).json({ error: message });
  }

  const result = await confirmSupplierAndRetry(invoice, supplier.id, wreq, {
    id: supplier.id,
    name: supplier.name,
    tax_number: supplier.taxNumber,
    score: 100,
  });
  if (!result.ok) return void res.status(result.status).json({ error: result.error });
  if (!result.outcome.success) {
    if (result.outcome.reason_code === "supplier_confirmation_required") {
      return void res.json({
        success: false,
        needs_supplier_confirmation: true,
        supplier_candidates: result.outcome.supplier_candidates ?? [],
        supplier_created: supplier.created,
      });
    }
    return void res.status(syncFailureStatus(result.outcome.error)).json({
      success: false,
      reason_code: result.outcome.reason_code,
      error: result.outcome.error ?? "Odoo sync failed",
      supplier_created: supplier.created,
    });
  }
  return void res.json({
    success: true,
    bill_id: result.outcome.provider_bill_id,
    bill_url: result.outcome.provider_bill_url,
    outcome: result.outcome.outcome ?? "created",
    supplier_id: supplier.id,
    supplier_name: supplier.name,
    supplier_created: supplier.created,
  });
});

router.get("/finance/invoice-review/odoo-issues", async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanAccess(wreq)) return void res.status(403).json({ error: "Finance access required" });
  const entityId = Number(req.query.entity_id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const afterId = Math.max(Number(req.query.after_id) || 0, 0);
  const values: unknown[] = [wreq.workspaceOwnerId];
   const filters = ["q.workspace_owner_id=$1", "q.superseded_by_import_id IS NULL", "q.effective_sync_status IN ('failed','blocked','needs_supplier_confirmation')"];
  if (Number.isInteger(entityId) && entityId > 0) {
    values.push(entityId);
    filters.push(`q.entity_id=$${values.length}`);
  }
  if (afterId > 0) {
    values.push(afterId);
    filters.push(`q.id>$${values.length}`);
  }
  values.push(limit);
  const result = await db.query(
    `WITH issue_rows AS (
       SELECT i.*, e.legal_name AS entity_legal_name, e.display_name AS entity_display_name,
              ${effectiveInvoiceSyncStatusSql("i", "e")} AS effective_sync_status
         FROM ai_invoice_imports i
         JOIN finance_entities e ON e.id=i.entity_id
        WHERE i.workspace_owner_id=$1
     )
     SELECT q.id,q.entity_id,q.entity_legal_name,q.entity_display_name,q.review_status,
            q.review_version,q.effective_sync_status,q.invoice_number,q.invoice_date,
            q.vendor_name,q.vendor_tax_number,q.vendor_address,q.currency,
            q.subtotal,q.tax_amount,q.total_amount,q.supplier_id,
            q.provider_bill_id,q.provider_bill_url,q.provider_sync_error,q.error_message,
            q.supplier_confirmation,
            COALESCE(NULLIF(q.provider_sync_error,''),NULLIF(q.error_message,''),'Odoo sync needs review') AS issue_message,
            CASE
              WHEN q.effective_sync_status='needs_supplier_confirmation' THEN 'supplier_confirmation'
              WHEN COALESCE(q.provider_sync_error,q.error_message,'') ILIKE '%supplier%' THEN 'supplier'
              WHEN COALESCE(q.provider_sync_error,q.error_message,'') ILIKE '%line%' THEN 'invoice_lines'
              WHEN COALESCE(q.provider_sync_error,q.error_message,'') ILIKE '%total%'
                OR COALESCE(q.provider_sync_error,q.error_message,'') ILIKE '%tax%' THEN 'amounts'
              WHEN q.effective_sync_status='blocked' THEN 'validation'
              ELSE 'retry'
            END AS issue_type,
            CASE
              WHEN q.effective_sync_status='needs_supplier_confirmation' THEN 'confirm_or_create_supplier'
              WHEN q.effective_sync_status='blocked' THEN 'edit_and_retry'
              ELSE 'retry_or_review'
            END AS suggested_action,
            s.name AS os_supplier_name,s.display_name AS os_supplier_display_name,
            s.tax_number AS os_supplier_tax_number,s.odoo_partner_id AS os_odoo_partner_id,
            count(*) OVER()::integer AS total_count
       FROM issue_rows q
       LEFT JOIN suppliers s ON s.id=q.supplier_id AND s.workspace_owner_id=q.workspace_owner_id
      WHERE ${filters.join(" AND ")}
      ORDER BY q.id ASC
      LIMIT $${values.length}`,
    values,
  );
  const rows = result.rows as Array<Record<string, unknown>>;
  const total = Number(rows[0]?.total_count ?? 0);
  res.json({
    issues: rows.map(({ total_count: _total, ...row }) => row),
    total,
    has_more: rows.length > 0 && rows.length < total,
    next_after_id: rows.length ? Number(rows[rows.length - 1].id) : afterId,
  });
});

router.post("/finance/invoice-review/confirm-suppliers", async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanApprove(wreq)) return void res.status(403).json({ error: "Approval permission required" });
  const rawConfirmations = (req.body as Record<string, unknown>).confirmations;
  if (!Array.isArray(rawConfirmations) || rawConfirmations.length === 0 || rawConfirmations.length > 200) {
    return void res.status(400).json({ error: "Provide between 1 and 200 supplier confirmations" });
  }

  const selections = rawConfirmations.map((item) => {
    const value = item as Record<string, unknown>;
    return {
      invoiceId: Number(value.invoice_id),
      providerSupplierId: Number(value.provider_supplier_id),
    };
  });
  if (selections.some((selection) => !Number.isInteger(selection.invoiceId) || selection.invoiceId <= 0
    || !Number.isInteger(selection.providerSupplierId) || selection.providerSupplierId <= 0)) {
    return void res.status(400).json({ error: "Each confirmation requires valid invoice_id and provider_supplier_id" });
  }
  if (new Set(selections.map((selection) => selection.invoiceId)).size !== selections.length) {
    return void res.status(400).json({ error: "Each invoice may only be confirmed once per batch" });
  }

  const invoiceIds = selections.map((selection) => selection.invoiceId);
  const invoices = await db.query<InvoiceImportRow>(
    `SELECT i.* FROM ai_invoice_imports i JOIN finance_entities e ON e.id=i.entity_id
      WHERE i.workspace_owner_id=$1 AND i.id=ANY($2::int[])`,
    [wreq.workspaceOwnerId, invoiceIds],
  );
  const invoicesById = new Map(invoices.rows.map((invoice) => [invoice.id, invoice]));
  const results: Array<{
    invoice_id: number;
    status: "succeeded" | "blocked" | "failed" | "needs_supplier_confirmation";
    outcome?: InvoiceSyncOutcome["outcome"];
    error?: string;
    supplier_candidates?: InvoiceSyncOutcome["supplier_candidates"];
  }> = [];

  for (const selection of selections) {
    const invoice = invoicesById.get(selection.invoiceId);
    if (!invoice) {
      results.push({ invoice_id: selection.invoiceId, status: "failed", error: "Invoice not found" });
      continue;
    }
    const result = await confirmSupplierAndRetry(invoice, selection.providerSupplierId, wreq);
    if (!result.ok) {
      results.push({ invoice_id: invoice.id, status: "failed", error: result.error });
      continue;
    }
    if (result.outcome.success) {
      results.push({
        invoice_id: invoice.id,
        status: "succeeded",
        outcome: result.outcome.outcome,
      });
    } else if (result.outcome.reason_code === "supplier_confirmation_required") {
      results.push({
        invoice_id: invoice.id,
        status: "needs_supplier_confirmation",
        error: result.outcome.error ?? "Needs supplier confirmation",
        supplier_candidates: result.outcome.supplier_candidates ?? [],
      });
    } else if (result.outcome.reason_code) {
      results.push({
        invoice_id: invoice.id,
        status: "blocked",
        error: result.outcome.error ?? "Invoice was blocked",
      });
    } else {
      results.push({
        invoice_id: invoice.id,
        status: "failed",
        error: result.outcome.error ?? "Sync failed",
      });
    }
  }

  res.json({
    success: results.every((result) => result.status === "succeeded"),
    processed: results.length,
    synced: results.filter((result) => result.status === "succeeded" && result.outcome !== "recovered" && result.outcome !== "verified_existing").length,
    recovered: results.filter((result) => result.outcome === "recovered" || result.outcome === "verified_existing").length,
    needs_supplier_confirmation: results.filter((result) => result.status === "needs_supplier_confirmation").length,
    blocked: results.filter((result) => result.status === "blocked").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  });
});

router.get("/finance/invoice-review/:id/audit", async (req, res) => {
  const wreq = workspace(req); if (!reviewCanAccess(wreq)) return void res.status(403).json({ error: "Finance access required" });
  const invoice = await reviewImport(req, res, Number(req.params.id)); if (!invoice) return;
  const result = await db.query(`SELECT id,actor_id,event_type,details,created_at FROM ai_invoice_import_audit_events WHERE import_id=$1 ORDER BY created_at DESC`, [invoice.id]);
  res.json({ events: result.rows });
});

/**
 * Read-only provider audit. This endpoint deliberately calls the connector's
 * read-only mode, which performs the same live stored-id/marker/reference
 * reconciliation as a sync but never invokes Odoo create.
 */
async function auditApprovedToOdoo(req: express.Request, res: express.Response) {
  const wreq = workspace(req);
  if (!reviewCanAccess(wreq)) return void res.status(403).json({ error: "Finance access required" });
  return auditApprovedToOdooForWorkspace(req, res, wreq.workspaceOwnerId);
}

async function auditApprovedToOdooForWorkspace(
  req: express.Request,
  res: express.Response,
  workspaceOwnerId: string,
) {
  const entityId = Number(req.query.entity_id);
  if (!Number.isInteger(entityId) || entityId <= 0) return void res.status(400).json({ error: "A valid Odoo finance entity is required" });
  const entityResult = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE id=$1 AND workspace_owner_id=$2`,
    [entityId, workspaceOwnerId],
  );
  const entity = entityResult.rows[0];
  if (!entity) return void res.status(404).json({ error: "Finance entity not found" });
  if (entity.accounting_system !== "odoo") return void res.status(422).json({ error: "The selected finance entity does not use Odoo" });
  if (!entity.odoo_base_url || !entity.odoo_database || !entity.odoo_company_id || !process.env.ODOO_API_KEY) {
    return void res.status(503).json({ error: "Odoo credentials are not configured on this entity" });
  }
  const afterRaw = Number(req.query.after_id ?? 0);
  const afterId = Number.isInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
  const candidates = await db.query<InvoiceImportRow>(
    `SELECT * FROM ai_invoice_imports
      WHERE workspace_owner_id=$1 AND entity_id=$2 AND id>$3
      ORDER BY id ASC
      LIMIT 100`,
    [workspaceOwnerId, entityId, afterId],
  );
  const results: Array<Record<string, unknown>> = [];
  const counts: Record<string, number> = {};
  const add = (invoice: InvoiceImportRow, reason_code: string, details: Record<string, unknown> = {}) => {
    counts[reason_code] = (counts[reason_code] ?? 0) + 1;
    results.push({ invoice_id: invoice.id, reason_code, ...details });
  };
  for (const invoice of candidates.rows) {
    if (invoice.review_status !== "approved") {
      add(invoice, "unapproved_or_rejected", { status: invoice.review_status ?? "unknown" });
      continue;
    }
    const destination = resolvedInvoiceDestination(invoice, entity);
    if (destination !== "odoo") {
      add(invoice, "alternate_destination", { destination: destination ?? "undecided" });
      continue;
    }
    if (!invoice.pdf_storage_path) {
      add(invoice, "source_unavailable", { error: "Source document is unavailable" });
      continue;
    }
    try {
      const result = await ensureInvoiceInOdoo(invoice, entity, { readOnly: true, workspaceOwnerId });
      if (!result.success) {
        if ("reason_code" in result && result.reason_code) {
          add(invoice, result.reason_code, { error: result.error });
        } else if (result.provider_bill_id) {
          add(invoice, "recoverable_bill", {
            external_reference: result.provider_bill_id,
            error: result.error ?? "Existing Odoo bill needs repair",
          });
        } else {
          add(invoice, /multiple|ambiguous|duplicate/i.test(result.error ?? "") ? "duplicate_blocked" : "provider_unavailable", { error: result.error ?? "Odoo audit failed" });
        }
      } else if (result.outcome === "eligible_create") {
        add(invoice, "eligible_create");
      } else if (result.outcome === "recovered") {
        add(invoice, "recovered_bill", { external_reference: result.provider_bill_id });
      } else {
        add(invoice, "verified_existing_bill", { external_reference: result.provider_bill_id });
      }
    } catch (error) {
      add(invoice, "provider_unavailable", { error: error instanceof Error ? error.message : "Odoo audit failed" });
    }
  }
  res.json({
    read_only: true,
    entity_id: entityId,
    audited: results.length,
    audit_complete: candidates.rows.length < 100,
    next_after_id: candidates.rows.at(-1)?.id ?? afterId,
    counts,
    results,
  });
}

router.post("/finance/invoice-review/sync-approved-to-odoo", async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanApprove(wreq)) return void res.status(403).json({ error: "Approval permission required" });

  const entityId = Number((req.body as Record<string, unknown>).entity_id);
  if (!Number.isInteger(entityId) || entityId <= 0) {
    return void res.status(400).json({ error: "A valid Odoo finance entity is required" });
  }

  const entityResult = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE id=$1 AND workspace_owner_id=$2`,
    [entityId, wreq.workspaceOwnerId],
  );
  const entity = entityResult.rows[0];
  if (!entity) return void res.status(404).json({ error: "Finance entity not found" });
  if (entity.accounting_system !== "odoo") {
    return void res.status(422).json({ error: "The selected finance entity does not use Odoo" });
  }
  // This is an entity-level gate, deliberately before credentials checks,
  // lease reclaim, or touching invoice state. A missing account is setup, not
  // an invoice failure, so Sync All must be completely side-effect free.
  if (entityRequiresOdooSetup(entity)) return void odooEntitySetupResponse(res);
  if (!entity.odoo_base_url || !entity.odoo_database || !entity.odoo_company_id || !process.env.ODOO_API_KEY) {
    return void res.status(503).json({ error: "Odoo credentials are not configured on this entity" });
  }
  const afterIdRaw = Number((req.body as Record<string, unknown>).after_id ?? 0);
  const afterId = Number.isInteger(afterIdRaw) && afterIdRaw >= 0 ? afterIdRaw : 0;

  // Reclaim expired attempt ownership before selecting the batch. Attempt
  // rows remain as history; only stale lease ownership and derived local state
  // are released so this same Sync All request can continue.
  await db.query(
    `UPDATE ai_invoice_import_sync_attempts attempt
        SET status='failed',
            error=concat(
              'Stale sync ownership reclaimed by Sync All at ',now(),
              '; previous status=',attempt.status,
              '; started_at=',attempt.started_at,
              '; lease_until=',coalesce(attempt.lease_until,attempt.started_at+interval '5 minutes'),
              '; destination=',coalesce(attempt.destination,'undecided'),
              '; idempotency_key=',attempt.idempotency_key
            ),
            completed_at=now(),lease_token=NULL,lease_until=NULL
       FROM ai_invoice_imports invoice
      WHERE attempt.import_id=invoice.id
        AND invoice.workspace_owner_id=$1
        AND invoice.entity_id=$2
        AND NOT ${SYNC_LEASE_ACTIVE_PREDICATE("attempt")}`,
    [wreq.workspaceOwnerId, entityId],
  );
  await db.query(
    `UPDATE ai_invoice_imports invoice
        SET sync_status='not_requested',
            provider_sync_status=CASE WHEN provider_sync_status='in_progress' THEN 'pending' ELSE provider_sync_status END,
            provider_sync_error=NULL,error_message=NULL,updated_at=now()
      WHERE invoice.workspace_owner_id=$1
        AND invoice.entity_id=$2
        AND invoice.review_status='approved'
        AND invoice.superseded_by_import_id IS NULL
        AND invoice.sync_status='in_progress'
        AND NOT EXISTS (
          SELECT 1 FROM ai_invoice_import_sync_attempts active_attempt
           WHERE active_attempt.import_id=invoice.id
             AND ${SYNC_LEASE_ACTIVE_PREDICATE("active_attempt")}
        )`,
    [wreq.workspaceOwnerId, entityId],
  );
  await mergeInvoiceGroupsIfSafe(wreq.workspaceOwnerId, { entityId });

  const candidates = await db.query<InvoiceImportRow>(
    `SELECT *,
       EXISTS (
         SELECT 1 FROM ai_invoice_import_sync_attempts verified_attempt
          WHERE verified_attempt.import_id=ai_invoice_imports.id
            AND verified_attempt.destination='odoo'
            AND verified_attempt.status='succeeded'
            AND verified_attempt.verified_at IS NOT NULL
            AND verified_attempt.external_reference=ai_invoice_imports.odoo_bill_id
       ) AS has_prior_odoo_attempt
       FROM ai_invoice_imports
      WHERE workspace_owner_id=$1
        AND entity_id=$2
         AND superseded_by_import_id IS NULL
        AND review_status='approved'
        AND sync_status <> 'needs_supplier_confirmation'
        AND NOT (
          sync_status='succeeded'
          AND
          provider_sync_status='succeeded'
          AND nullif(provider_bill_id,'') IS NOT NULL
          AND provider_bill_status IS DISTINCT FROM 'failed'
          AND provider_bill_id=odoo_bill_id
          AND nullif(odoo_bill_id,'') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ai_invoice_import_sync_attempts authoritative_attempt
             WHERE authoritative_attempt.import_id=ai_invoice_imports.id
               AND authoritative_attempt.destination='odoo'
               AND authoritative_attempt.status='succeeded'
               AND authoritative_attempt.verified_at IS NOT NULL
               AND authoritative_attempt.external_reference=ai_invoice_imports.odoo_bill_id
          )
          AND EXISTS (
            SELECT 1 FROM supplier_invoices ledger
             WHERE ledger.ai_import_id=ai_invoice_imports.id
               AND ledger.workspace_owner_id=ai_invoice_imports.workspace_owner_id
               AND ledger.odoo_sync_status='synced'
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM ai_invoice_import_sync_attempts active_attempt
           WHERE active_attempt.import_id=ai_invoice_imports.id
             AND ${SYNC_LEASE_ACTIVE_PREDICATE("active_attempt")}
        )
         AND NOT EXISTS (
           SELECT 1
             FROM ai_invoice_imports sibling
            WHERE sibling.workspace_owner_id=ai_invoice_imports.workspace_owner_id
              AND sibling.entity_id=ai_invoice_imports.entity_id
              AND sibling.id<>ai_invoice_imports.id
              AND sibling.superseded_by_import_id IS NULL
              AND upper(regexp_replace(trim(sibling.invoice_number),'\\s+',' ','g'))
                  =upper(regexp_replace(trim(ai_invoice_imports.invoice_number),'\\s+',' ','g'))
              AND upper(trim(coalesce(sibling.currency,'')))
                  =upper(trim(coalesce(ai_invoice_imports.currency,'')))
         )
        /* These fields are informational only. They never decide eligibility;
           each row is reconciled against live Odoo by the canonical service. */
        AND id>$3
      ORDER BY id ASC
      LIMIT 100`,
    [wreq.workspaceOwnerId, entityId, afterId],
  );

  const results: Array<{
    invoice_id: number;
    status: "succeeded" | "failed" | "skipped" | "blocked" | "needs_supplier_confirmation";
    external_reference?: string;
    error?: string;
    reason_code?: string;
    outcome?: "created" | "recovered" | "verified_existing" | "repaired_existing" | "eligible_create";
    stale_local_state?: boolean;
    supplier_confirmation?: {
      invoice_number: string | null;
      vendor_name: string | null;
      suggested_supplier: {
        id: number;
        name: string;
        display_name?: string | null;
        tax_number?: string | null;
        score: number;
      } | null;
      candidates: Array<{
        id: number;
        name: string;
        display_name?: string | null;
        tax_number?: string | null;
        score: number;
      }>;
    };
  }> = [];

  const processedCanonicalIds = new Set<number>();
  for (const invoice of candidates.rows) {
    let invoiceForCandidate = invoice;
    invoiceForCandidate = await mergeInvoicePagesIfSafe(invoiceForCandidate, wreq.workspaceOwnerId);
    if (invoiceForCandidate.superseded_by_import_id) {
      results.push({ invoice_id: invoice.id, status: "skipped", error: "Invoice was superseded by a merged canonical invoice", reason_code: "superseded" });
      continue;
    }
    if (processedCanonicalIds.has(invoiceForCandidate.id)) {
      continue;
    }
    processedCanonicalIds.add(invoiceForCandidate.id);
    if (invoiceForCandidate.review_status !== "approved") {
      results.push({
        invoice_id: invoice.id,
        status: "skipped",
        error: "Canonical invoice is not approved",
        reason_code: "lifecycle_changed",
      });
      continue;
    }
    if (invoiceForCandidate.review_status === "approved" && ["failed", "blocked"].includes(invoiceForCandidate.sync_status ?? "")) {
      // Failed/blocked is local recovery state, not provider identity. Clear
      // only transient fields in a guarded transition; attempt rows and the
      // approved snapshot remain historical evidence.
      const previousStatus = invoiceForCandidate.sync_status;
      const canonicalId = invoiceForCandidate.id;
      const reset = await db.query<InvoiceImportRow>(
        `UPDATE ai_invoice_imports
            SET sync_status='not_requested',
                provider_sync_status='pending',
                provider_sync_error=NULL,
                error_message=NULL,
                updated_at=now()
          WHERE id=$1 AND workspace_owner_id=$2
            AND review_status='approved'
            AND superseded_by_import_id IS NULL
            AND sync_status IN ('failed','blocked')
            AND NOT EXISTS (
              SELECT 1 FROM ai_invoice_import_sync_attempts live_attempt
               WHERE live_attempt.import_id=ai_invoice_imports.id
                 AND ${SYNC_LEASE_ACTIVE_PREDICATE("live_attempt")}
            )
          RETURNING *`,
         [invoiceForCandidate.id, wreq.workspaceOwnerId],
      );
      if (reset.rowCount) {
        if (reset.rows[0]) invoiceForCandidate = reset.rows[0];
        await auditReview(canonicalId, wreq.userId, "automatic_sync_recovery_reset", {
          canonical_id: canonicalId,
          previous_status: previousStatus,
          next_status: "not_requested",
        });
      } else {
        results.push({ invoice_id: invoiceForCandidate.id, status: "skipped", error: "Invoice changed before recovery reset", reason_code: "active_sync" });
        continue;
      }
    }
    const currentInvoice = invoiceForCandidate;
    const destination = resolvedInvoiceDestination(currentInvoice, entity);
    if (destination !== "odoo") {
      results.push({
        invoice_id: invoice.id,
        status: "skipped",
        error: `Invoice destination resolves to ${destination ?? "undecided"}`,
        reason_code: "alternate_destination",
      });
      continue;
    }
    const verifiedBillId = String(currentInvoice.provider_bill_id ?? currentInvoice.odoo_bill_id ?? "").trim();
    const hasVerifiedProviderBill = Boolean(
      (invoice as InvoiceImportRow & { has_prior_odoo_attempt?: boolean }).has_prior_odoo_attempt,
    ) && verifiedBillId;
    if (hasVerifiedProviderBill) {
      try {
        await syncImportedSupplierInvoice(currentInvoice.id, wreq.workspaceOwnerId);
        results.push({
          invoice_id: currentInvoice.id,
          status: "succeeded",
          external_reference: verifiedBillId,
          outcome: "repaired_existing",
        });
        continue;
      } catch (error) {
        // A local ledger repair can fail transiently even when the provider
        // identity is authoritative. Fall through once to canonical Odoo
        // reconciliation, which can repair and finalize the ledger together.
      }
    }
    if (!currentInvoice.pdf_storage_path) {
      await db.query(
        `UPDATE ai_invoice_imports SET sync_status='blocked',error_message=$1,updated_at=now() WHERE id=$2 AND workspace_owner_id=$3`,
        ["Source document is unavailable", currentInvoice.id, wreq.workspaceOwnerId],
      );
       results.push({ invoice_id: currentInvoice.id, status: "blocked", error: "Source document is unavailable", reason_code: "source_unavailable" });
      continue;
    }
    let safety: Awaited<ReturnType<typeof validateOdooSyncSafety>>;
    try {
      safety = await validateOdooSyncSafety(currentInvoice, wreq.workspaceOwnerId);
    } catch (error) {
      results.push({
        invoice_id: invoice.id,
        status: "failed",
        error: error instanceof Error ? error.message : "Invoice validation failed",
        reason_code: "validation_failed",
      });
      continue;
    }
    const invoiceForSync = safety.invoice;
    const localSuccess = invoiceForSync.provider_sync_status === "succeeded"
      || invoiceForSync.sync_status === "succeeded"
      || !!invoiceForSync.odoo_bill_id;
    if (safety.blocked) {
      await db.query(
        `UPDATE ai_invoice_imports SET sync_status='blocked',error_message=$1,updated_at=now() WHERE id=$2 AND workspace_owner_id=$3 AND superseded_by_import_id IS NULL`,
        [safety.blocked.error, invoiceForSync.id, wreq.workspaceOwnerId],
      );
      results.push({
        invoice_id: invoiceForSync.id,
        status: "skipped",
        error: safety.blocked.error,
        reason_code: safety.blocked.reason_code,
      });
      continue;
    }
    let claimed: SyncClaim | null;
    try {
      claimed = await claimInvoiceSyncAttempt(invoiceForSync, "odoo", wreq.workspaceOwnerId, {
        idempotencyKey: `historical-odoo:${invoiceForSync.id}:${invoiceForSync.review_version ?? 1}:retry:${randomUUID()}`,
        requireApproved: true,
      });
    } catch (error) {
      results.push({
        invoice_id: invoiceForSync.id,
        status: "failed",
        error: error instanceof Error ? error.message : "Invoice claim failed",
        reason_code: "claim_failed",
      });
      continue;
    }
    if (!claimed) {
      results.push({ invoice_id: invoiceForSync.id, status: "skipped", error: "Invoice is already being synced", reason_code: "active_sync" });
      continue;
    }

    let outcome: InvoiceSyncOutcome;
    try {
      outcome = await ensureInvoiceInOdoo(
        invoiceForSync,
        entity,
        {
          attemptId: claimed.attemptId,
          leaseToken: claimed.leaseToken,
          workspaceOwnerId: wreq.workspaceOwnerId,
          actorId: wreq.userId,
            // This invoice passed validateOdooSyncSafety immediately before
            // claiming the lease; do not repeat validation after the claim.
            skipValidation: true,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invoice sync failed";
      // Provider/ledger exceptions must not strand the leased attempt or
      // leave the invoice permanently in_progress. The next bulk run should
      // be able to retry it through the normal idempotent reconciliation.
      await db.query(
        `UPDATE ai_invoice_import_sync_attempts
            SET status='failed',error=$1,completed_at=now(),lease_until=NULL
          WHERE id=$2 AND lease_token=$3`,
        [message, claimed.attemptId, claimed.leaseToken],
      );
      await db.query(
        `UPDATE ai_invoice_imports
            SET sync_status='failed',provider_sync_status='failed',
                provider_sync_error=$1,error_message=$1,updated_at=now()
          WHERE id=$2 AND workspace_owner_id=$3 AND review_version=$4`,
        [message, invoiceForSync.id, wreq.workspaceOwnerId, invoiceForSync.review_version],
      );
      results.push({ invoice_id: invoiceForSync.id, status: "failed", error: message, reason_code: "provider_failed" });
      continue;
    }
    if (!outcome.success && outcome.reason_code === "supplier_confirmation_required") {
      const candidates = outcome.supplier_candidates ?? [];
      results.push({
        invoice_id: invoiceForSync.id,
        status: "needs_supplier_confirmation",
        error: "Needs supplier confirmation",
        reason_code: "supplier_confirmation_required",
        supplier_confirmation: {
          invoice_number: invoiceForSync.invoice_number,
          vendor_name: invoiceForSync.vendor_name,
          suggested_supplier: candidates[0] ?? null,
          candidates,
        },
      });
      continue;
    }
    if (!outcome.success && "reason_code" in outcome && outcome.reason_code) {
      await db.query(
        `UPDATE ai_invoice_imports SET sync_status='blocked',error_message=$1,updated_at=now() WHERE id=$2 AND workspace_owner_id=$3 AND superseded_by_import_id IS NULL`,
        [outcome.error, invoiceForSync.id, wreq.workspaceOwnerId],
      );
      results.push({
        invoice_id: invoiceForSync.id,
        status: "blocked",
        error: outcome.error,
        reason_code: outcome.reason_code,
      });
      continue;
    }
    results.push(outcome.success
      ? {
         invoice_id: invoiceForSync.id,
        status: "succeeded",
        external_reference: outcome.provider_bill_id,
        outcome: outcome.outcome,
        reason_code: localSuccess && outcome.outcome !== "verified_existing"
          ? "stale_local_success_repaired"
          : outcome.outcome === "verified_existing"
            ? "verified_existing_bill"
            : outcome.outcome === "recovered"
              ? "recovered_bill"
              : "eligible_create",
        stale_local_state: localSuccess && outcome.outcome !== "verified_existing",
      }
      : {
         invoice_id: invoiceForSync.id,
        status: "failed",
        error: outcome.error ?? "Sync failed",
        reason_code: "provider_failed",
        stale_local_state: localSuccess,
      });
  }

  const synced = results.filter((result) => result.status === "succeeded").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped" || result.status === "blocked" || result.status === "needs_supplier_confirmation").length;
  const needs_supplier_confirmation = results.filter((result) => result.status === "needs_supplier_confirmation").length;
  const blocked = results.filter((result) => result.status === "blocked").length;
  const recovered = results.filter((result) => result.outcome === "recovered").length;
  const created = results.filter((result) => result.outcome === "created" || result.outcome === "eligible_create").length;
  const reason_breakdown = results.reduce<Record<string, number>>((counts, result) => {
    const key = result.reason_code ?? (result.status === "failed" ? "provider_failed" : "other");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  res.json({
    success: failed === 0,
    selected: candidates.rows.length,
    synced,
    failed,
    skipped,
     created,
     recovered,
     verified_existing: results.filter((result) => result.outcome === "verified_existing").length,
    stale_repaired: results.filter((result) => result.stale_local_state).length,
     needs_supplier_confirmation,
     blocked,
     confirmations: results
       .filter((result) => result.status === "needs_supplier_confirmation" && result.supplier_confirmation)
       .map((result) => ({ invoice_id: result.invoice_id, ...result.supplier_confirmation })),
    reason_breakdown,
    has_more: candidates.rows.length === 100,
    next_after_id: candidates.rows.at(-1)?.id ?? afterId,
    results,
  });
});

router.get("/finance/invoice-review/:id/neighbors", async (req, res) => {
  const wreq = workspace(req); if (!reviewCanAccess(wreq)) return void res.status(403).json({ error: "Finance access required" });
  const invoice = await reviewImport(req, res, Number(req.params.id)); if (!invoice) return;
  const effectiveSyncStatus = effectiveInvoiceSyncStatusSql();
  const filters = ["i.workspace_owner_id=$1"];
  const values: unknown[] = [wreq.workspaceOwnerId];
  const entityId = Number(req.query.entity_id);
  if (Number.isInteger(entityId)) { values.push(entityId); filters.push(`i.entity_id=$${values.length}`); }
  if (typeof req.query.review_status === "string") { values.push(req.query.review_status); filters.push(`i.review_status=$${values.length}`); }
  if (typeof req.query.sync_status === "string") { values.push(req.query.sync_status); filters.push(`${effectiveSyncStatus}=$${values.length}`); }
  if (typeof req.query.supplier_id === "string" && Number.isInteger(Number(req.query.supplier_id))) { values.push(Number(req.query.supplier_id)); filters.push(`i.supplier_id=$${values.length}`); }
  if (req.query.search !== undefined && typeof req.query.search !== "string") return void res.status(400).json({ error: "search must be a string" });
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (search.length > 200) return void res.status(400).json({ error: "search must be 200 characters or fewer" });
  if (search) {
    values.push(`%${search}%`);
    const searchPlaceholder = `$${values.length}`;
    const searchFilters = [
      `i.vendor_name ILIKE ${searchPlaceholder}`,
      `i.invoice_number ILIKE ${searchPlaceholder}`,
      `EXISTS(SELECT 1 FROM suppliers sf WHERE sf.id=i.supplier_id AND sf.workspace_owner_id=i.workspace_owner_id AND (sf.name ILIKE ${searchPlaceholder} OR sf.display_name ILIKE ${searchPlaceholder}))`,
    ];
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(search)) {
      values.push(search);
      searchFilters.push(`i.total_amount=$${values.length}::numeric`);
    }
    filters.push(`(${searchFilters.join(" OR ")})`);
  }
  const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from : req.query.from;
  const dateTo = typeof req.query.date_to === "string" ? req.query.date_to : req.query.to;
  if (typeof dateFrom === "string") { values.push(dateFrom); filters.push(`i.invoice_date >= $${values.length}`); }
  if (typeof dateTo === "string") { values.push(dateTo); filters.push(`i.invoice_date <= $${values.length}`); }
  values.push(invoice.id);
  const result = await db.query<{ previous_id: number | null; next_id: number | null; position: string; total: string }>(
    `WITH filtered AS (
       SELECT i.id,
              row_number() OVER (ORDER BY i.created_at DESC,i.id DESC) position,
              count(*) OVER () total,
              lag(i.id) OVER (ORDER BY i.created_at DESC,i.id DESC) previous_id,
              lead(i.id) OVER (ORDER BY i.created_at DESC,i.id DESC) next_id
         FROM ai_invoice_imports i
        WHERE ${filters.join(" AND ")}
     )
     SELECT previous_id,next_id,position,total FROM filtered WHERE id=$${values.length}`,
    values,
  );
  const navigation = result.rows[0];
  res.json(navigation ? {
    previous_id: navigation.previous_id,
    next_id: navigation.next_id,
    position: Number(navigation.position),
    total: Number(navigation.total),
  } : { previous_id: null, next_id: null, position: null, total: 0 });
});

router.get("/finance/invoice-review/:id/source", async (req, res) => {
  const wreq = workspace(req); if (!reviewCanAccess(wreq)) return void res.status(403).json({ error: "Finance access required" });
  const invoice = await sourceImport(req, res, Number(req.params.id)); if (!invoice) return;
  if (!invoice.pdf_storage_path) return void res.status(404).json({ error: "Source document is unavailable" });
  try {
    const file = await objectStorageService.getObjectEntityFile(invoice.pdf_storage_path);
    const [bytes] = await file.download();
    const metadata = ((invoice as Record<string, unknown>).source_metadata ?? {}) as Record<string, unknown>;
    const contentType = typeof metadata.mime_type === "string" && SUPPORTED_MIME_TYPES.has(metadata.mime_type) ? metadata.mime_type : "application/pdf";
    res.type(contentType);
    const disposition = req.query.download === "true" ? "attachment" : "inline";
    const filename = String(metadata.filename ?? invoice.original_filename ?? `invoice-${invoice.id}`).replace(/["\r\n]/g, "");
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);
    res.send(bytes);
  } catch {
    // Do not disclose storage paths or provider errors.
    res.status(404).json({ error: "Source document is unavailable" });
  }
});

router.get("/finance/invoice-review/:id/source-pages", async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanAccess(wreq)) return void res.status(403).json({ error: "Finance access required" });
  const invoice = await reviewImport(req, res, Number(req.params.id)); if (!invoice) return;
  if (!invoice.source_batch_id) {
    const mergedDocuments = Array.isArray(invoice.source_metadata?.merged_source_documents)
      ? invoice.source_metadata.merged_source_documents as Array<Record<string, unknown>>
      : [];
    if (!mergedDocuments.length) return void res.json({ pages: [] });
    return void res.json({
      pages: mergedDocuments.map((document) => ({
        import_id: Number(document.import_id),
        page_number: null,
        page_count: null,
        filename: document.filename ?? null,
        available: !!document.path,
        url: document.path ? `/api/finance/invoice-review/${Number(document.import_id)}/source` : null,
        superseded_by_import_id: Number(document.import_id) === invoice.id ? null : invoice.id,
        supersede_reason: Number(document.import_id) === invoice.id ? null : "multi_page_invoice_merge",
      })),
    });
  }
  const pages = await db.query<InvoiceImportRow>(
    `SELECT id,source_page_number,source_page_count,original_filename,pdf_storage_path,status,
            superseded_by_import_id,supersede_reason
       FROM ai_invoice_imports
      WHERE workspace_owner_id=$1 AND source_batch_id=$2
      ORDER BY source_page_number NULLS LAST,id ASC`,
    [wreq.workspaceOwnerId, invoice.source_batch_id],
  );
  res.json({
    pages: pages.rows.map((page) => ({
      import_id: page.id,
      page_number: page.source_page_number,
      page_count: page.source_page_count,
      filename: page.original_filename,
      available: !!page.pdf_storage_path,
      url: page.pdf_storage_path ? `/api/finance/invoice-review/${page.id}/source` : null,
      superseded_by_import_id: page.superseded_by_import_id ?? null,
      supersede_reason: page.supersede_reason ?? null,
    })),
  });
});

router.put("/finance/invoice-review/:id/source", invoiceSourceFile, async (req, res) => {
  const wreq = workspace(req);
  if (!reviewCanUploadSource(wreq)) return void res.status(403).json({ error: "Finance review access required" });
  const invoice = await reviewImport(req, res, Number(req.params.id));
  if (!invoice) return;
  const file = req.file;
  if (!file) return void res.status(400).json({ error: "A PDF, JPG, PNG, or WEBP source file is required" });
  const mimeType = resolveSupportedMime(file);
  if (!mimeType) return void res.status(400).json({ error: "Only PDF, JPG, PNG, or WEBP files are allowed" });
  const version = validVersion(req.body as Record<string, unknown>);
  if (version !== invoice.review_version) return void res.status(409).json({ error: "Invoice was changed by another reviewer", version: invoice.review_version });
    if (invoice.sync_status === "pending" || invoice.sync_status === "in_progress" || invoice.sync_status === "succeeded" || invoice.provider_sync_status === "succeeded") {
    return void res.status(409).json({ error: "The source cannot be replaced after accounting sync has started" });
  }
  try {
    // A source replacement changes the evidence behind the review. Always
    // invalidate approval and the reviewed snapshot, including restoration of
    // a source that was previously missing.
    await persistInvoiceSource(invoice.id, file, mimeType, wreq.workspaceOwnerId, { expectedVersion: version, invalidateReview: true });
    await auditReview(invoice.id, wreq.userId, "source_replaced", { mime_type: mimeType, byte_size: file.buffer.length });
    res.json({
      success: true,
      source_document: {
        available: true,
        url: `/api/finance/invoice-review/${invoice.id}/source`,
        content_type: mimeType,
        filename: file.originalname,
        byte_size: file.buffer.length,
      },
      review_version: version + 1,
    });
  } catch (error) {
    logger.warn({ err: error, importId: invoice.id }, "finance: source replacement failed");
    res.status(503).json({ error: "Source document storage failed. Please retry the replacement." });
  }
});

router.post(["/finance/invoice-review/:id/sync", "/finance/invoice-review/:id/retry-sync"], async (req, res) => {
  const wreq = workspace(req); if (!reviewCanApprove(wreq)) return void res.status(403).json({ error: "Approval permission required" });
  let invoice = await reviewImport(req, res, Number(req.params.id)); if (!invoice) return;
  const body = req.body as Record<string, unknown>; let version = validVersion(body);
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  const retrying = req.path.endsWith("/retry-sync");
  let automaticRecoveryReset = false;
  if (invoice.review_status !== "approved") return void res.status(409).json({ error: "Invoice must be approved before sync" });
  if (version !== invoice.review_version || !idempotencyKey || idempotencyKey.length > 200) {
    return void res.status(400).json({ error: "Valid version and idempotency_key are required" });
  }
  // Resolve entity setup before recovery, leases, status resets, or any
  // connector work. This is a configuration problem and must not be recorded
  // as an invoice-level failure.
  const earlyEntityResult = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities WHERE id=$1 AND workspace_owner_id=$2`,
    [invoice.entity_id, wreq.workspaceOwnerId],
  );
  const earlyEntity = earlyEntityResult.rows[0];
  if (!earlyEntity) return void res.status(404).json({ error: "Finance entity not found" });
  if (resolvedInvoiceDestination(invoice, earlyEntity) === "odoo" && entityRequiresOdooSetup(earlyEntity)) {
    return void odooEntitySetupResponse(res);
  }
  const mergedInvoice = await mergeInvoicePagesIfSafe(invoice, wreq.workspaceOwnerId);
  if (mergedInvoice.superseded_by_import_id) {
    return void res.status(409).json({ error: "Invoice was superseded by a merged canonical invoice", reason_code: "superseded" });
  }
  invoice = mergedInvoice;
  version = invoice.review_version ?? version;
  // The attempt lease is authoritative. Expired/orphaned ownership and a
  // derived stale in_progress flag are repaired before validation so this
  // request continues without requiring another Retry click.
  const ownership = await recoverInvoiceSyncOwnership(invoice, wreq.workspaceOwnerId, wreq.userId);
  invoice = ownership.invoice;
  if (ownership.active) {
    return void res.status(409).json({
      error: "Sync attempt is already active",
      sync_status: ownership.active.status,
      active_attempt: ownership.active,
    });
  }
  if (invoice.review_status === "approved" && ["failed", "blocked"].includes(invoice.sync_status ?? "")) {
    const previousStatus = invoice.sync_status;
    const reset = await db.query<InvoiceImportRow>(
      `UPDATE ai_invoice_imports
          SET sync_status='not_requested',
              provider_sync_status='pending',
              provider_sync_error=NULL,
              error_message=NULL,
              updated_at=now()
        WHERE id=$1 AND workspace_owner_id=$2
          AND review_status='approved'
          AND superseded_by_import_id IS NULL
          AND review_version=$3
          AND sync_status IN ('failed','blocked')
          AND NOT EXISTS (
            SELECT 1 FROM ai_invoice_import_sync_attempts live_attempt
             WHERE live_attempt.import_id=ai_invoice_imports.id
               AND ${SYNC_LEASE_ACTIVE_PREDICATE("live_attempt")}
          )
        RETURNING *`,
      [invoice.id, wreq.workspaceOwnerId, version],
    );
    if (!reset.rowCount) return void res.status(409).json({ error: "Invoice changed before recovery reset" });
    if (reset.rows[0]) invoice = reset.rows[0];
    automaticRecoveryReset = true;
    await auditReview(invoice.id, wreq.userId, "automatic_sync_recovery_reset", {
      previous_status: previousStatus,
      next_status: "not_requested",
    });
  }
  const entity = earlyEntity;
  const destination = resolvedInvoiceDestination(invoice, entity);
  const authoritativeBillId = String(invoice.provider_bill_id ?? invoice.odoo_bill_id ?? "").trim();
  const verifiedProviderAttempt = retrying && destination === "odoo" && authoritativeBillId
    ? await db.query<{ external_reference: string }>(
      `SELECT external_reference FROM ai_invoice_import_sync_attempts
        WHERE import_id=$1 AND destination='odoo' AND status='succeeded'
          AND verified_at IS NOT NULL AND external_reference=$2 LIMIT 1`,
      [invoice.id, authoritativeBillId],
    )
    : { rows: [] };
  if (verifiedProviderAttempt.rows[0]?.external_reference === authoritativeBillId) {
    try {
      await syncImportedSupplierInvoice(invoice.id, wreq.workspaceOwnerId);
      const repaired = await db.query(
        `SELECT 1
           FROM ai_invoice_imports i
           JOIN supplier_invoices si
             ON si.ai_import_id=i.id AND si.workspace_owner_id=i.workspace_owner_id
          WHERE i.id=$1 AND i.workspace_owner_id=$2
            AND i.sync_status='succeeded'
            AND si.odoo_sync_status='synced'
            AND si.odoo_bill_id=$3`,
        [invoice.id, wreq.workspaceOwnerId, authoritativeBillId],
      );
      if (!repaired.rowCount) throw new Error("Supplier ledger could not be finalized");
      await auditReview(invoice.id, wreq.userId, "ledger_repaired", { external_reference: authoritativeBillId });
      return void res.json({
        success: true,
        idempotent: true,
        ledger_repair: true,
        destination: "odoo",
        external_reference: authoritativeBillId,
        sync: { status: "succeeded", destination: "odoo", external_reference: authoritativeBillId },
      });
    } catch (error) {
      logger.error({ err: error, importId: invoice.id }, "finance: ledger-only repair failed");
      // A local ledger-only repair can fail transiently. Keep the
      // authoritative bill identity and continue once through the canonical
      // Odoo reconciliation path below.
    }
  }
  if (destination !== "odoo") {
    if (retrying && invoice.sync_status !== "failed" && !automaticRecoveryReset) {
      return void res.status(409).json({ error: "Only a failed accounting sync can be retried" });
    }
    if (!retrying && invoice.sync_status !== "not_requested") {
      return void res.status(409).json({ error: "Only an approved invoice awaiting sync can be synced" });
    }
  }
  const invoiceForSync = destination === "odoo"
    ? (await validateOdooSyncSafety(invoice, wreq.workspaceOwnerId))
    : { invoice, blocked: null, validation: null };
  if (invoiceForSync.blocked) {
      return void res.status(422).json({
        error: invoiceForSync.blocked.error,
        reason_code: invoiceForSync.blocked.reason_code,
        validation: invoiceForSync.validation,
      });
  }
  const ledgerRepair = retrying && invoice.provider_sync_status === "succeeded";
  if (!ledgerRepair && (destination !== "odoo" && destination !== "wafeq")) {
    return void res.status(422).json({ error: "Choose Odoo or Wafeq as the invoice destination before syncing" });
  }
  const leaseToken = randomUUID();
  let attemptKey = idempotencyKey;
  let claimed = await db.query<{ id: number; status: string }>(
    `INSERT INTO ai_invoice_import_sync_attempts(import_id,idempotency_key,review_version,status,destination)
     VALUES($1,$2,$3,'pending',$4)
     ON CONFLICT(import_id,idempotency_key) DO NOTHING
     RETURNING id,status`, [invoice.id, attemptKey, version, destination ?? "undecided"]);
  if (!claimed.rowCount) {
    const existing = await db.query<{
      id: number;
      status: string;
      destination: string;
      external_reference: string | null;
      error: string | null;
      active: boolean;
      lease_until: string | Date | null;
      heartbeat_age_seconds: number | string | null;
    }>(
      `SELECT status,destination,external_reference,error,id,lease_until,
          ${SYNC_LEASE_ACTIVE_PREDICATE("ai_invoice_import_sync_attempts")} AS active,
          ${SYNC_LEASE_HEARTBEAT_AGE_SQL("ai_invoice_import_sync_attempts")} AS heartbeat_age_seconds
         FROM ai_invoice_import_sync_attempts
        WHERE import_id=$1 AND idempotency_key=$2`,
      [invoice.id, attemptKey],
    );
    if (existing.rows[0]?.status === "succeeded") {
      if (retrying && destination === "odoo") {
        try {
          if (destination !== "odoo" || !entity) throw new Error("Odoo entity is unavailable");
          const repairOutcome = await ensureInvoiceInOdoo(invoiceForSync.invoice, entity, {
            attemptId: existing.rows[0].id,
            leaseToken,
            workspaceOwnerId: wreq.workspaceOwnerId,
            actorId: wreq.userId,
            allowMissingPersistence: true,
          });
          if (!repairOutcome.success) throw new Error(repairOutcome.error ?? "Odoo reconciliation failed");
        } catch {
          return void res.status(502).json({ success: false, error: "Accounting sync completed but invoice ledger update failed; please retry the ledger sync." });
        }
      }
      return void res.json({ success: true, idempotent: true, destination: existing.rows[0].destination, external_reference: existing.rows[0].external_reference, sync: { status: "succeeded", destination: existing.rows[0].destination, external_reference: existing.rows[0].external_reference } });
    }
    const activeExisting = existing.rows[0];
    if (activeExisting?.active) {
      return void res.status(409).json({
        error: "Sync attempt is already active",
        sync_status: activeExisting.status,
        active_attempt: {
          attempt_id: activeExisting.id,
          lease_until: activeExisting.lease_until,
          heartbeat_age_seconds: Number(activeExisting.heartbeat_age_seconds ?? 0),
        },
      });
    }
    // A failed, completed, or expired local attempt is historical state, not
    // a reason to block a legitimate approved-invoice retry. Keep it intact
    // and allocate a fresh local key even when an older caller did not set
    // retrying. ensureInvoiceInOdoo still performs authoritative provider
    // reconciliation using the stable invoice marker before any create.
    const activeAttempt = await db.query<{ id: number; lease_until: string | Date | null; heartbeat_age_seconds: number | string | null }>(
      `SELECT id,lease_until,
              ${SYNC_LEASE_HEARTBEAT_AGE_SQL("ai_invoice_import_sync_attempts")} AS heartbeat_age_seconds
         FROM ai_invoice_import_sync_attempts
        WHERE import_id=$1
          AND ${SYNC_LEASE_ACTIVE_PREDICATE("ai_invoice_import_sync_attempts")}
        LIMIT 1`,
      [invoice.id],
    );
    if (activeAttempt.rows[0]) {
      return void res.status(409).json({
        error: "Sync attempt is already active",
        sync_status: "in_progress",
        active_attempt: {
          attempt_id: activeAttempt.rows[0].id,
          lease_until: activeAttempt.rows[0].lease_until,
          heartbeat_age_seconds: Number(activeAttempt.rows[0].heartbeat_age_seconds ?? 0),
        },
      });
    }
    attemptKey = `retry:${invoice.id}:${version}:${randomUUID()}`;
    claimed = await db.query<{ id: number; status: string }>(
      `INSERT INTO ai_invoice_import_sync_attempts(import_id,idempotency_key,review_version,status,destination)
       VALUES($1,$2,$3,'pending',$4)
       RETURNING id,status`,
      [invoice.id, attemptKey, version, destination ?? "undecided"],
    );
  }
  const attemptLease = await db.query(`UPDATE ai_invoice_import_sync_attempts SET status='in_progress',lease_token=$1,lease_until=now()+interval '5 minutes' WHERE id=$2 AND (status='pending' OR (status='in_progress' AND lease_until < now()))`, [leaseToken, claimed.rows[0].id]);
  if (!attemptLease.rowCount) return void res.status(409).json({ error: "Sync attempt is already claimed" });
  const lock = await db.query(
    `UPDATE ai_invoice_imports
        SET sync_status='in_progress',updated_at=now()
      WHERE id=$1
        AND review_version=$2
        AND review_status='approved'
        AND superseded_by_import_id IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM ai_invoice_import_sync_attempts active_attempt
           WHERE active_attempt.import_id=$1
             AND active_attempt.id<>$3
             AND ${SYNC_LEASE_ACTIVE_PREDICATE("active_attempt")}
        )`,
    [invoice.id, version, claimed.rows[0].id],
  );
  if (!lock.rowCount) {
    await db.query(
      `UPDATE ai_invoice_import_sync_attempts
          SET status='failed',error='Invoice lifecycle or claim was lost',completed_at=now(),lease_until=NULL
        WHERE id=$1 AND lease_token=$2 AND status='in_progress'`,
      [claimed.rows[0].id, leaseToken],
    );
    return void res.status(409).json({ error: "Sync already in progress or reviewed values changed" });
  }
  if (!entity) return void res.status(404).json({ error: "Finance entity not found" });
  const outcome = destination === "odoo"
    ? await ensureInvoiceInOdoo(invoiceForSync.invoice, entity, {
      attemptId: claimed.rows[0].id,
      leaseToken,
      workspaceOwnerId: wreq.workspaceOwnerId,
      actorId: wreq.userId,
    })
    : await executeInvoiceSync(invoice, entity, destination ?? "undecided", claimed.rows[0].id, leaseToken, wreq.workspaceOwnerId, wreq.userId);
   if (!outcome.success && outcome.reason_code === "supplier_confirmation_required") {
     return void res.json({
       success: false,
       destination,
       supplier_confirmation: {
         vendor_name: invoice.vendor_name,
         candidates: outcome.supplier_candidates ?? [],
       },
       sync: {
         status: "needs_supplier_confirmation",
         destination,
         supplier_candidates: outcome.supplier_candidates ?? [],
       },
     });
   }
    if (!outcome.success) return void res.status(syncFailureStatus(outcome.error)).json({
    success: false,
    destination,
    external_reference: outcome.provider_bill_id,
     reason_code: outcome.reason_code,
    error: outcome.error ?? "Sync failed",
    sync: {
      status: "failed",
      destination,
      external_reference: outcome.provider_bill_id,
       reason_code: outcome.reason_code,
      error: outcome.error ?? "Sync failed",
    },
  });
  res.json({ success: true, destination, external_reference: outcome.provider_bill_id, sync: { status: "succeeded", destination, external_reference: outcome.provider_bill_id } });
});

router.delete("/finance/ai-invoice-import/imports/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid import id" });
    return;
  }

  const result = await db.query(
    `DELETE FROM ai_invoice_imports WHERE id = $1 AND workspace_owner_id = $2 RETURNING id`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Import not found" });
    return;
  }

  res.json({ success: true });
});

export default router;
