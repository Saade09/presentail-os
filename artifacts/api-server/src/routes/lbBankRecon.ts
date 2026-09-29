import { Router } from "express";
import { createHash } from "crypto";
import { randomUUID } from "crypto";
import multer from "multer";
import { db, withTransaction } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { resolveWorkspace, workspace } from "../lib/workspace.js";
import { logger } from "../lib/logger.js";
import { createConnector } from "../lib/finance/connectorFactory.js";
import type { FinanceEntityRow } from "./finance.js";
import { objectStorageClient, objectStorageService } from "../lib/objectStorage.js";
import { parseBLOMBuffer, BLOMParseError } from "../lib/lbBankRecon/blomParser.js";
import { computeLineFingerprint } from "../lib/lbBankRecon/fingerprint.js";
import {
  normaliseOdooBaseUrl,
  sanitiseOdooBaseUrlForResponse,
} from "../lib/finance/odooUrl.js";
import { OdooJson2Client } from "../lib/finance/odooJson2Client.js";
import type { OdooJournal } from "../lib/finance/odooJson2Client.js";
import {
  currenciesCompatible,
  LEBANON_ODOO_COMPANY_ID,
  LEBANON_ODOO_COMPANY_NAME,
} from "../lib/finance/bankReconValidation.js";

const router = Router();
router.use(requireAuth, resolveWorkspace);

// ── Permission helpers ────────────────────────────────────────────────────────

function hasFinanceAccounting(wreq: ReturnType<typeof workspace>): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    (wreq.allowedPages?.includes("finance_accounting") ?? false)
  );
}

function hasFinanceManagerApproval(wreq: ReturnType<typeof workspace>): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    (wreq.allowedPages?.includes("finance_manager") ?? false)
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type LbBankAccountRow = {
  id: number;
  workspace_owner_id: string;
  bank_name: string;
  account_name: string;
  masked_account_number: string | null;
  currency: string;
  is_active: boolean;
  is_required_for_close: boolean;
  odoo_journal_id: number | null;
  odoo_journal_name: string | null;
  created_at: string;
  updated_at: string;
};

function getOdooHealthError(status: number, responseText: string, token: string): string {
  if (status === 401 || status === 403) {
    return "Odoo authentication failed. Verify the integration token configured in Odoo.";
  }
  if (status === 404) {
    return "Odoo health endpoint was not found. Install or enable the bank reconciliation addon.";
  }
  if (status === 408 || status === 429 || status >= 500) {
    return `Odoo is unavailable (HTTP ${status}). Check the Odoo service and try again.`;
  }
  const redactedText = token ? responseText.split(token).join("[redacted]") : responseText;
  const detail = redactedText.replace(/\s+/g, " ").trim().slice(0, 160);
  return `Odoo rejected the health check (HTTP ${status})${detail ? `: ${detail}` : ""}`;
}

function getOdooNetworkHealthError(error: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  const names: string[] = [];
  const codes: string[] = [];
  const messages: string[] = [];

  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      names.push(current.name);
      messages.push(current.message);
      const details = current as Error & { code?: unknown; cause?: unknown };
      if (typeof details.code === "string") codes.push(details.code);
      current = details.cause;
    } else {
      break;
    }
  }

  const combined = [...names, ...codes, ...messages].join(" ").toLowerCase();
  if (
    combined.includes("aborterror") ||
    combined.includes("timeouterror") ||
    combined.includes("etimedout") ||
    combined.includes("timed out")
  ) {
    return "Odoo health check timed out. Check the endpoint and network access.";
  }
  if (
    combined.includes("enotfound") ||
    combined.includes("eai_again") ||
    combined.includes("getaddrinfo") ||
    combined.includes("dns")
  ) {
    return "Odoo hostname could not be resolved. Check the base URL and DNS configuration.";
  }
  if (
    combined.includes("certificate") ||
    combined.includes("cert_") ||
    combined.includes("tls") ||
    combined.includes("ssl") ||
    combined.includes("self_signed")
  ) {
    return "Odoo TLS verification failed. Check the server certificate and hostname.";
  }
  return "Unable to reach Odoo. Check the base URL and network access.";
}

function getOdooNetworkErrorLogDetails(error: unknown): {
  errorName: string;
  errorCode?: string;
} {
  if (!(error instanceof Error)) return { errorName: "UnknownError" };
  const code = (error as Error & { code?: unknown }).code;
  return {
    errorName: error.name,
    ...(typeof code === "string" ? { errorCode: code } : {}),
  };
}

function getOdooJson2DiagnosticError(error: unknown): string {
  const details = error as { status?: unknown; message?: unknown };
  const status = typeof details.status === "number" ? details.status : null;
  const message = typeof details.message === "string" ? details.message : "";
  if (status === null && error instanceof Error) return getOdooNetworkHealthError(error);
  if (status === 401) return "Odoo JSON-2 authentication failed. Verify the configured ODOO_API_KEY.";
  if (status === 403) return "Odoo JSON-2 permissions are insufficient for the required accounting models.";
  if (status === 404) return "Odoo JSON-2 database, model, or method was not found. Verify the database name.";
  if (/database/i.test(message)) return `Odoo JSON-2 database validation failed: ${message}`;
  if (/company/i.test(message)) return `Odoo company validation failed: ${message}`;
  if (/journal/i.test(message)) return `Odoo bank-journal validation failed: ${message}`;
  return message || "Odoo JSON-2 diagnostics failed";
}

// ── Lebanon entity guard ──────────────────────────────────────────────────────

/**
 * Resolves the Presentail Lebanon finance entity (country = 'LB') for the
 * current workspace.  Returns the entity row, or sends a 403 and returns null
 * when no Lebanon entity exists.
 */
async function requireLebanonEntity(
  wreq: ReturnType<typeof workspace>,
  res: Parameters<Parameters<Router["get"]>[1]>[1],
): Promise<{ id: number } | null> {
  const result = await db.query<{ id: number }>(
    `SELECT id FROM finance_entities
      WHERE workspace_owner_id = $1
        AND country = 'LB'
        AND is_active = true
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [wreq.workspaceOwnerId],
  );
  if (!result.rowCount || result.rowCount === 0) {
    res.status(403).json({
      error: "This feature is only available for Presentail Lebanon workspaces",
    });
    return null;
  }
  return result.rows[0];
}

// ── Audit log helper ──────────────────────────────────────────────────────────

/**
 * Inserts an immutable audit row into lb_bank_audit_log.
 * Must be called inside the same transaction as the mutating query so that
 * every account change is atomically paired with its audit record.
 */
async function writeLbAuditLog(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  params: {
    workspaceOwnerId: string;
    actorId: string;
    accountId: number | null;
    action: string;
    before: unknown;
    after: unknown;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO lb_bank_audit_log
       (workspace_owner_id, actor_id, account_id, action, before, after, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.workspaceOwnerId,
      params.actorId,
      params.accountId ?? null,
      params.action,
      params.before !== undefined ? JSON.stringify(params.before) : null,
      params.after !== undefined ? JSON.stringify(params.after) : null,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
}

// ── GET /lb-bank-recon/accounts ───────────────────────────────────────────────
// When ?month=M&year=YYYY are provided, enriches each account row with
// statement import status, Odoo sync status, reconciliation status, and
// matched/unmatched/synced line counts for that period.

router.get("/lb-bank-recon/accounts", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }

  const entity = await requireLebanonEntity(wreq, res);
  if (!entity) return;

  const includeInactive = req.query.include_inactive === "true";
  const monthStr = req.query.month ? String(req.query.month) : null;
  const yearStr = req.query.year ? String(req.query.year) : null;
  const month = monthStr ? parseInt(monthStr, 10) : null;
  const year = yearStr ? parseInt(yearStr, 10) : null;

  // When month/year provided, use a LATERAL join to pull statement stats for that period.
  if (month !== null && year !== null && !isNaN(month) && !isNaN(year)) {
    const result = await db.query<LbBankAccountRow & {
      statement_id: number | null;
      original_filename: string | null;
      statement_status: string | null;
      odoo_sync_status: string | null;
      reconciliation_status: string | null;
      reconciled_at: string | null;
      period_start: string | null;
      period_end: string | null;
      total_lines: string | null;
      matched_count: string | null;
      unmatched_count: string | null;
      unclassified_count: string | null;
      synced_count: string | null;
      last_sync_at: string | null;
    }>(
      `SELECT
          a.*,
          stmt.id              AS statement_id,
          stmt.original_filename,
          stmt.status          AS statement_status,
          stmt.odoo_sync_status,
          stmt.reconciliation_status,
          stmt.reconciled_at,
          stmt.period_start,
          stmt.period_end,
          stmt.total_lines,
          stmt.matched_count,
          stmt.unmatched_count,
          stmt.unclassified_count,
          stmt.synced_count,
          stmt.last_sync_at
       FROM lb_bank_accounts a
       LEFT JOIN LATERAL (
         SELECT
           s.id,
           s.original_filename,
           s.status,
           s.odoo_sync_status,
           s.reconciliation_status,
           s.reconciled_at,
           s.period_start,
           s.period_end,
           COUNT(l.id) FILTER (WHERE l.line_type = 'posted')                                   AS total_lines,
           COUNT(l.id) FILTER (WHERE l.line_type = 'posted' AND l.is_matched = true)           AS matched_count,
           COUNT(l.id) FILTER (WHERE l.line_type = 'posted' AND l.is_matched = false)          AS unmatched_count,
           COUNT(l.id) FILTER (WHERE l.line_type = 'posted' AND l.classification IS NULL)      AS unclassified_count,
           COUNT(os.id) FILTER (WHERE os.status = 'success')                                   AS synced_count,
           MAX(os.synced_at)                                                                    AS last_sync_at
         FROM lb_bank_statements s
         LEFT JOIN lb_bank_statement_lines l  ON l.statement_id = s.id
         LEFT JOIN lb_bank_statement_odoo_syncs os ON os.line_id = l.id
         WHERE s.account_id = a.id
           AND s.workspace_owner_id = $1
            AND CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                     THEN substring(s.period_start from 7 for 4)::int END = $2
            AND CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                     THEN substring(s.period_start from 4 for 2)::int END = $3
            AND CASE WHEN s.period_end ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                     THEN substring(s.period_end from 7 for 4)::int END = $2
            AND CASE WHEN s.period_end ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                     THEN substring(s.period_end from 4 for 2)::int END = $3
         GROUP BY s.id
         ORDER BY s.created_at DESC
         LIMIT 1
       ) stmt ON true
       WHERE a.workspace_owner_id = $1
         ${includeInactive ? "" : "AND a.is_active = true"}
       ORDER BY a.bank_name ASC, a.account_name ASC`,
      [wreq.workspaceOwnerId, year, month],
    );
    res.json({ accounts: result.rows, month, year });
    return;
  }

  // No period filter — return bare account list (backward-compatible).
  const conditions = ["workspace_owner_id = $1"];
  if (!includeInactive) conditions.push("is_active = true");

  const result = await db.query<LbBankAccountRow>(
    `SELECT * FROM lb_bank_accounts
      WHERE ${conditions.join(" AND ")}
      ORDER BY bank_name ASC, account_name ASC`,
    [wreq.workspaceOwnerId],
  );

  res.json({ accounts: result.rows });
});

// ── POST /lb-bank-recon/accounts ──────────────────────────────────────────────

router.post("/lb-bank-recon/accounts", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }

  const entity = await requireLebanonEntity(wreq, res);
  if (!entity) return;

  const {
    bank_name,
    account_name,
    masked_account_number,
    currency = "LBP",
    is_required_for_close = false,
    odoo_journal_id,
    odoo_journal_name,
  } = req.body as Record<string, unknown>;

  if (!bank_name || typeof bank_name !== "string" || !bank_name.trim()) {
    res.status(400).json({ error: "bank_name is required" });
    return;
  }
  if (!account_name || typeof account_name !== "string" || !account_name.trim()) {
    res.status(400).json({ error: "account_name is required" });
    return;
  }
  if (!currency || typeof currency !== "string" || !currency.trim()) {
    res.status(400).json({ error: "currency is required" });
    return;
  }
  let canonicalJournalName: string | null = null;
  if (odoo_journal_id !== null && odoo_journal_id !== undefined && odoo_journal_id !== "") {
    const journalId = Number(odoo_journal_id);
    if (!Number.isInteger(journalId) || journalId <= 0) {
      res.status(400).json({ error: "odoo_journal_id must be a positive integer" });
      return;
    }
    const validation = await validateLiveJournalMapping(
      wreq.workspaceOwnerId,
      journalId,
      String(currency).trim().toUpperCase(),
    );
    if (!validation.journal) {
      res.status(422).json({ error: validation.error ?? "Invalid Odoo journal mapping" });
      return;
    }
    canonicalJournalName = validation.journal.name;
  }

  const actorId = wreq.userId ?? "unknown";
  const client = await db.connect();
  try {
    const account = await withTransaction(client, async () => {
      const result = await client.query<LbBankAccountRow>(
        `INSERT INTO lb_bank_accounts
           (workspace_owner_id, bank_name, account_name, masked_account_number,
            currency, is_required_for_close, odoo_journal_id, odoo_journal_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          wreq.workspaceOwnerId,
          String(bank_name).trim(),
          String(account_name).trim(),
          masked_account_number ? String(masked_account_number).trim() : null,
          String(currency).trim().toUpperCase(),
          is_required_for_close === true || is_required_for_close === "true",
          odoo_journal_id ? Number(odoo_journal_id) : null,
          canonicalJournalName,
        ],
      );
      const acc = result.rows[0];
      await writeLbAuditLog(client, {
        workspaceOwnerId: wreq.workspaceOwnerId,
        actorId,
        accountId: acc.id,
        action: "create_account",
        before: null,
        after: acc,
      });
      return acc;
    });
    res.status(201).json({ account });
  } catch (err: unknown) {
    const pg = err as { code?: string };
    if (pg.code === "23505") {
      res.status(409).json({
        error:
          "A bank account with this bank name, account name, and currency already exists",
      });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
});

// ── GET /lb-bank-recon/accounts/:id ──────────────────────────────────────────

router.get("/lb-bank-recon/accounts/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }

  const entity = await requireLebanonEntity(wreq, res);
  if (!entity) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid account id" });
    return;
  }

  const result = await db.query<LbBankAccountRow>(
    `SELECT * FROM lb_bank_accounts WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (!result.rowCount || result.rowCount === 0) {
    res.status(404).json({ error: "Bank account not found" });
    return;
  }

  res.json({ account: result.rows[0] });
});

// ── PATCH /lb-bank-recon/accounts/:id ────────────────────────────────────────

router.patch("/lb-bank-recon/accounts/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }

  const entity = await requireLebanonEntity(wreq, res);
  if (!entity) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid account id" });
    return;
  }

  const body = req.body as Record<string, unknown>;

  // Validate that the body has at least one recognised field.
  const knownFields = [
    "bank_name", "account_name", "masked_account_number", "currency",
    "is_active", "is_required_for_close", "odoo_journal_id", "odoo_journal_name",
  ];
  if (!knownFields.some((f) => f in body)) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  if ("odoo_journal_name" in body && !("odoo_journal_id" in body)) {
    res.status(400).json({ error: "odoo_journal_name is server-canonical and must be supplied with odoo_journal_id" });
    return;
  }
  if ("odoo_journal_id" in body) {
    if (body.odoo_journal_id === null || body.odoo_journal_id === "") {
      // Clearing a mapping needs no live Odoo validation.
    } else {
      const journalId = Number(body.odoo_journal_id);
      if (!Number.isInteger(journalId) || journalId <= 0) {
        res.status(400).json({ error: "odoo_journal_id must be a positive integer" });
        return;
      }
    }
  }

  const actorId = wreq.userId ?? "unknown";
  const client = await db.connect();
  try {
    const after = await withTransaction(client, async () => {
      // Lock the row inside the transaction so the before snapshot is accurate
      // even under concurrent mutations.
      const locked = await client.query<LbBankAccountRow>(
        `SELECT * FROM lb_bank_accounts
          WHERE id = $1 AND workspace_owner_id = $2
          FOR UPDATE`,
        [id, wreq.workspaceOwnerId],
      );
      if (!locked.rowCount || locked.rowCount === 0) return null;
      const before = locked.rows[0];
      let canonicalPatchJournalName: string | null | undefined;
      let clearPatchJournal = false;

      // The live mapping validation intentionally happens after FOR UPDATE.
      // Otherwise a concurrent currency update could validate a journal against
      // an old currency and commit a stale mapping.
      const requestedJournalId = "odoo_journal_id" in body && body.odoo_journal_id
        ? Number(body.odoo_journal_id)
        : ("odoo_journal_id" in body ? null : before.odoo_journal_id);
      if (requestedJournalId) {
        const mappingCurrency = "currency" in body && body.currency
          ? String(body.currency).trim().toUpperCase()
          : before.currency;
        const validation = await validateLiveJournalMapping(
          wreq.workspaceOwnerId,
          requestedJournalId,
          mappingCurrency,
        );
        if (!validation.journal) {
          return { validationError: validation.error ?? "Invalid Odoo journal mapping" };
        }
        canonicalPatchJournalName = validation.journal.name;
      } else if (
        !("odoo_journal_id" in body) &&
        "currency" in body &&
        body.currency &&
        before.odoo_journal_id
      ) {
        const validation = await validateLiveJournalMapping(
          wreq.workspaceOwnerId,
          before.odoo_journal_id,
          String(body.currency).trim().toUpperCase(),
        );
        if (validation.journal) {
          canonicalPatchJournalName = validation.journal.name;
        } else {
          clearPatchJournal = true;
          canonicalPatchJournalName = null;
        }
      } else if ("odoo_journal_id" in body && !body.odoo_journal_id) {
        canonicalPatchJournalName = null;
      }

      // Build the SET clause using the locked row as fallback for omitted fields.
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, val: unknown) => {
        values.push(val);
        fields.push(`${col} = $${values.length}`);
      };

      if ("bank_name" in body)
        set("bank_name", body.bank_name ? String(body.bank_name).trim() : before.bank_name);
      if ("account_name" in body)
        set("account_name", body.account_name ? String(body.account_name).trim() : before.account_name);
      if ("masked_account_number" in body)
        set("masked_account_number", body.masked_account_number ? String(body.masked_account_number).trim() : null);
      if ("currency" in body)
        set("currency", body.currency ? String(body.currency).trim().toUpperCase() : before.currency);
      if ("is_active" in body)
        set("is_active", body.is_active === true || body.is_active === "true");
      if ("is_required_for_close" in body)
        set("is_required_for_close", body.is_required_for_close === true || body.is_required_for_close === "true");
      if ("odoo_journal_id" in body)
        set("odoo_journal_id", body.odoo_journal_id ? Number(body.odoo_journal_id) : null);
      if (clearPatchJournal)
        set("odoo_journal_id", null);
      if (canonicalPatchJournalName !== undefined)
        set("odoo_journal_name", canonicalPatchJournalName);

      values.push(id, wreq.workspaceOwnerId);
      const updated = await client.query<LbBankAccountRow>(
        `UPDATE lb_bank_accounts
            SET ${fields.join(", ")}, updated_at = now()
          WHERE id = $${values.length - 1} AND workspace_owner_id = $${values.length}
          RETURNING *`,
        values,
      );
      const acc = updated.rows[0];

      await writeLbAuditLog(client, {
        workspaceOwnerId: wreq.workspaceOwnerId,
        actorId,
        accountId: id,
        action: "update_account",
        before,
        after: acc,
      });
      return acc;
    });

    if (!after) {
      res.status(404).json({ error: "Bank account not found" });
      return;
    }
    if ("validationError" in after) {
      res.status(422).json({ error: after.validationError });
      return;
    }
    res.json({ account: after });
  } catch (err: unknown) {
    const pg = err as { code?: string };
    if (pg.code === "23505") {
      res.status(409).json({
        error:
          "A bank account with this bank name, account name, and currency already exists",
      });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
});

// ── DELETE /lb-bank-recon/accounts/:id (soft-delete via is_active = false) ───

router.delete("/lb-bank-recon/accounts/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }

  const entity = await requireLebanonEntity(wreq, res);
  if (!entity) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid account id" });
    return;
  }

  const actorId = wreq.userId ?? "unknown";
  const client = await db.connect();
  try {
    const result = await withTransaction(client, async () => {
      // Lock the row so the before snapshot is accurate under concurrent mutations.
      const locked = await client.query<LbBankAccountRow>(
        `SELECT * FROM lb_bank_accounts
          WHERE id = $1 AND workspace_owner_id = $2
          FOR UPDATE`,
        [id, wreq.workspaceOwnerId],
      );
      if (!locked.rowCount || locked.rowCount === 0) return null;
      const before = locked.rows[0];

      const updated = await client.query<LbBankAccountRow>(
        `UPDATE lb_bank_accounts
            SET is_active = false, updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2
          RETURNING *`,
        [id, wreq.workspaceOwnerId],
      );
      const after = updated.rows[0];

      // Audit insert is inside the transaction — a failure here rolls back the
      // deactivation so we never return success with a missing audit record.
      await writeLbAuditLog(client, {
        workspaceOwnerId: wreq.workspaceOwnerId,
        actorId,
        accountId: id,
        action: "deactivate_account",
        before,
        after,
      });
      return after;
    });

    if (!result) {
      res.status(404).json({ error: "Bank account not found" });
      return;
    }
    res.json({ success: true, account: result });
  } finally {
    client.release();
  }
});

// ── Helpers for statement-scoped routes ──────────────────────────────────────

type LbBankStatementRow = {
  id: number;
  workspace_owner_id: string;
  account_id: number;
  original_filename: string | null;
  storage_path: string | null;
  file_hash: string | null;
  period_start: string | null;
  period_end: string | null;
  status: string;
  uploaded_by: string;
  error_message: string | null;
  metadata: Record<string, unknown>;
  odoo_sync_status: string;
  reconciliation_status: string;
  reconciled_by: string | null;
  reconciled_at: string | null;
  created_at: string;
  updated_at: string;
};

type LbBankStatementLineRow = {
  id: number;
  statement_id: number;
  workspace_owner_id: string;
  line_date: string | null;
  value_date: string | null;
  description: string | null;
  reference: string | null;
  debit_amount: string | null;
  credit_amount: string | null;
  balance: string | null;
  currency: string;
  line_type: string;
  fingerprint: string | null;
  is_matched: boolean;
  metadata: Record<string, unknown>;
  classification: string | null;
  classification_reason: string | null;
  classified_by: string | null;
  classified_at: string | null;
  created_at: string;
};

/** Fetch a statement row that belongs to the workspace — sends 404 on miss. */
async function requireStatement(
  statementId: number,
  workspaceOwnerId: string,
  res: Parameters<Parameters<Router["get"]>[1]>[1],
): Promise<LbBankStatementRow | null> {
  const result = await db.query<LbBankStatementRow>(
    `SELECT s.*, a.odoo_journal_id, a.odoo_journal_name
       FROM lb_bank_statements s
       JOIN lb_bank_accounts a ON a.id = s.account_id
      WHERE s.id = $1 AND s.workspace_owner_id = $2`,
    [statementId, workspaceOwnerId],
  );
  if (!result.rowCount || result.rowCount === 0) {
    res.status(404).json({ error: "Statement not found" });
    return null;
  }
  return result.rows[0];
}

/** Fetch the active Lebanon finance entity with full Odoo credentials. */
async function requireLebanonEntityFull(
  workspaceOwnerId: string,
  res: Parameters<Parameters<Router["get"]>[1]>[1],
): Promise<FinanceEntityRow | null> {
  const result = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities
      WHERE workspace_owner_id = $1
        AND country = 'LB'
        AND is_active = true
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [workspaceOwnerId],
  );
  if (!result.rowCount || result.rowCount === 0) {
    res.status(403).json({
      error: "This feature is only available for Presentail Lebanon workspaces",
    });
    return null;
  }
  return result.rows[0];
}

async function validateLiveJournalMapping(
  workspaceOwnerId: string,
  journalId: number,
  accountCurrency: string,
): Promise<{ journal: OdooJournal | null; error?: string }> {
  const result = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities
       WHERE workspace_owner_id = $1
         AND country = 'LB'
         AND is_active = true
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
    [workspaceOwnerId],
  );
  const entity = result.rows[0];
  const base = entity ? normaliseOdooBaseUrl(entity.odoo_base_url) : null;
  if (
    !entity ||
    entity.accounting_system !== "odoo" ||
    !base?.ok ||
    !entity.odoo_database ||
    entity.odoo_company_id !== LEBANON_ODOO_COMPANY_ID ||
    entity.odoo_company_name?.trim() !== LEBANON_ODOO_COMPANY_NAME ||
    !process.env.ODOO_API_KEY
  ) {
    return { journal: null, error: "Configure the Lebanon Odoo JSON-2 connection before mapping a journal." };
  }
  try {
    const client = new OdooJson2Client({
      baseUrl: base.url,
      database: entity.odoo_database,
      companyId: entity.odoo_company_id,
    });
    const journal = await client.validateJournal(journalId);
    const company = await client.getCompany();
    if (
      company.id !== LEBANON_ODOO_COMPANY_ID ||
      company.name.trim() !== LEBANON_ODOO_COMPANY_NAME
    ) {
      return { journal: null, error: "Odoo company 2 must be Presentail SAL." };
    }
    // Odoo exposes company-currency journals with currency_id = false/null.
    // Treat that as the company's currency rather than rejecting a valid LBP
    // journal mapping.
    const effectiveCurrency = journal.currency_name || company.currency_name;
    if (!effectiveCurrency || !currenciesCompatible(effectiveCurrency, accountCurrency)) {
      return {
        journal: null,
        error: `Odoo journal "${journal.name}" is not compatible with bank-account currency ${accountCurrency}.`,
      };
    }
    return { journal };
  } catch (error) {
    return {
      journal: null,
      error: error instanceof Error ? error.message : "Unable to validate the Odoo journal",
    };
  }
}

// Valid exception classification values
const VALID_CLASSIFICATIONS = new Set([
  "matched",
  "bank_fee",
  "inter_account",
  "inter_entity",
  "timing_difference",
  "duplicate_excluded",
  "unidentified",
]);

// Classifications that require a reason string
const CLASSIFICATION_REQUIRES_REASON = new Set([
  "bank_fee",
  "inter_account",
  "inter_entity",
  "timing_difference",
  "duplicate_excluded",
  "unidentified",
]);

// ── POST /lb-bank-recon/statements/:id/sync ───────────────────────────────────
// Syncs all posted, not-yet-successfully-synced lines to the Odoo Lebanon
// bank journal.  Idempotent: lines with a successful sync record are skipped.

router.post("/lb-bank-recon/statements/:id/sync", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }

  const stmtId = parseInt(req.params.id, 10);
  if (isNaN(stmtId)) {
    res.status(400).json({ error: "Invalid statement id" });
    return;
  }

  const entity = await requireLebanonEntityFull(wreq.workspaceOwnerId, res);
  if (!entity) return;
  const baseUrlResult = normaliseOdooBaseUrl(entity.odoo_base_url);
  if (
    entity.accounting_system !== "odoo" ||
    !baseUrlResult.ok ||
    !entity.odoo_database ||
    entity.odoo_company_id !== LEBANON_ODOO_COMPANY_ID ||
    entity.odoo_company_name?.trim() !== LEBANON_ODOO_COMPANY_NAME ||
    !process.env.ODOO_API_KEY
  ) {
    res.status(422).json({
      error: "Configure and successfully check Presentail SAL (Odoo company 2) before syncing.",
    });
    return;
  }

  const stmtResult = await requireStatement(stmtId, wreq.workspaceOwnerId, res);
  if (!stmtResult) return;

  // Read-only lock: reject mutations when the period is already closed.
  if (await isPeriodClosedForStatement(stmtId, wreq.workspaceOwnerId)) {
    res.status(423).json({
      error: "Period is closed — this statement is read-only. Reopen the month to make changes.",
    });
    return;
  }

  // stmtResult has odoo_journal_id injected by the JOIN in requireStatement
  const stmt = stmtResult as LbBankStatementRow & {
    odoo_journal_id: number | null;
    odoo_journal_name: string | null;
  };

  const journalId = stmt.odoo_journal_id;
  if (!journalId) {
    res.status(422).json({
      error: "No Odoo journal configured for this bank account. Set odoo_journal_id on the account first.",
    });
    return;
  }

  // Serialize all attempts for this statement, including the remote Odoo
  // calls. A transaction-level lock would be released during the network
  // round-trip, so use a session advisory lock and always unlock in finally.
  const syncLockClient = await db.connect();
  const lockKey = `lb-bank-recon:sync:${wreq.workspaceOwnerId}:${stmtId}`;
  let lockResult: { rows: Array<{ locked: boolean }> };
  try {
    lockResult = await syncLockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [lockKey],
    );
  } catch (error) {
    syncLockClient.release();
    throw error;
  }
  if (!lockResult.rows[0]?.locked) {
    syncLockClient.release();
    res.status(409).json({ error: "This statement is already syncing. Wait for the current sync to finish." });
    return;
  }

  const fingerprintLockKeys: string[] = [];
  const releaseFingerprintLocks = async () => {
    for (const fingerprintLockKey of [...fingerprintLockKeys].reverse()) {
      await syncLockClient.query(
        `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
        [fingerprintLockKey],
      );
    }
    fingerprintLockKeys.length = 0;
  };

  try {
  // Fetch posted lines with no successful sync record
  const linesResult = await db.query<LbBankStatementLineRow>(
    `SELECT l.*
       FROM lb_bank_statement_lines l
      WHERE l.statement_id = $1
        AND l.line_type = 'posted'
        AND NOT EXISTS (
          SELECT 1 FROM lb_bank_statement_odoo_syncs os
           WHERE os.line_id = l.id AND os.status = 'success'
        )
      ORDER BY l.line_date ASC, l.id ASC`,
    [stmtId],
  );

  const linesToSync = linesResult.rows;

  if (linesToSync.length === 0) {
    // Nothing new to sync — check current overall status and return early
    const existingSync = await db.query<{ total: string; synced: string }>(
      `SELECT
         COUNT(l.id) FILTER (WHERE l.line_type = 'posted')              AS total,
         COUNT(os.id) FILTER (WHERE os.status = 'success')              AS synced
       FROM lb_bank_statement_lines l
       LEFT JOIN lb_bank_statement_odoo_syncs os ON os.line_id = l.id
       WHERE l.statement_id = $1`,
      [stmtId],
    );
    const { total, synced } = existingSync.rows[0] ?? { total: "0", synced: "0" };
    res.json({
      message: "All posted lines already synced",
      synced_count: parseInt(synced, 10),
      total_count: parseInt(total, 10),
      results: [],
    });
    return;
  }

  const missingFingerprint = linesToSync.find((line) => !line.fingerprint?.trim());
  if (missingFingerprint) {
    res.status(422).json({
      error: "Every posted line must have a durable fingerprint before Odoo sync; no Odoo records were created.",
    });
    return;
  }

  const fingerprintLockKeysToAcquire = [...new Set(
    linesToSync.map((line) =>
      `lb-bank-recon:fingerprint:${wreq.workspaceOwnerId}:${journalId}:${line.fingerprint!.trim()}`,
    ),
  )].sort();
  for (const fingerprintLockKey of fingerprintLockKeysToAcquire) {
    const fingerprintLockResult = await syncLockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [fingerprintLockKey],
    );
    if (!fingerprintLockResult.rows[0]?.locked) {
      await releaseFingerprintLocks();
      res.status(409).json({
        error: "Another statement is syncing the same bank-line fingerprint. Wait for that sync to finish.",
      });
      return;
    }
    fingerprintLockKeys.push(fingerprintLockKey);
  }

  const connector = createConnector(entity);
  const actorId = wreq.userId ?? "unknown";

  logger.info(
    { statementId: stmtId, lineCount: linesToSync.length },
    "lbBankRecon: starting Odoo sync",
  );

  // Call the connector — connector handles batching internally
  const syncResults = await connector.syncBankStatementLines(
    entity.id,
    journalId,
    linesToSync.map((l) => ({
      id: l.id,
      line_date: l.line_date,
      value_date: l.value_date,
      description: l.description,
      reference: l.reference,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
      balance: l.balance,
      currency: l.currency,
      metadata: {
        ...(l.metadata ?? {}),
        statement_id: stmtId,
        statement_filename: stmt.original_filename,
        period_start: stmt.period_start,
        period_end: stmt.period_end,
      },
       fingerprint: l.fingerprint,
    })),
  );

  // Upsert each result into lb_bank_statement_odoo_syncs
  const client = await db.connect();
  let successCount = 0;
  let failCount = 0;

  try {
    await withTransaction(client, async () => {
      for (const r of syncResults) {
        const status = r.success ? "success" : "failed";
        if (r.success) successCount++; else failCount++;

        await client.query(
          `INSERT INTO lb_bank_statement_odoo_syncs
             (line_id, workspace_owner_id, status, odoo_record_id, odoo_record_url, error_message, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (line_id) DO UPDATE
             SET status         = EXCLUDED.status,
                 odoo_record_id = EXCLUDED.odoo_record_id,
                 odoo_record_url= EXCLUDED.odoo_record_url,
                 error_message  = EXCLUDED.error_message,
                 synced_at      = EXCLUDED.synced_at,
                 updated_at     = now()`,
          [
            r.lineId,
            wreq.workspaceOwnerId,
            status,
            r.odooRecordId ?? null,
            r.odooRecordUrl ?? null,
            r.error ?? null,
            r.success ? new Date().toISOString() : null,
          ],
        );
      }

      // Recompute overall statement odoo_sync_status
      const totals = await client.query<{ total: string; synced: string; failed: string }>(
        `SELECT
           COUNT(l.id) FILTER (WHERE l.line_type = 'posted')              AS total,
           COUNT(os.id) FILTER (WHERE os.status = 'success')              AS synced,
           COUNT(os.id) FILTER (WHERE os.status = 'failed')               AS failed
         FROM lb_bank_statement_lines l
         LEFT JOIN lb_bank_statement_odoo_syncs os ON os.line_id = l.id
         WHERE l.statement_id = $1`,
        [stmtId],
      );
      const { total, synced, failed } = totals.rows[0] ?? { total: "0", synced: "0", failed: "0" };
      const totalN = parseInt(total, 10);
      const syncedN = parseInt(synced, 10);
      const failedN = parseInt(failed, 10);

      let newSyncStatus: string;
      if (syncedN === totalN && totalN > 0) newSyncStatus = "synced";
      else if (failedN > 0 && syncedN > 0) newSyncStatus = "partial";
      else if (failedN > 0 && syncedN === 0) newSyncStatus = "failed";
      else newSyncStatus = "not_synced";

      await client.query(
        `UPDATE lb_bank_statements
            SET odoo_sync_status = $1, updated_at = now()
          WHERE id = $2`,
        [newSyncStatus, stmtId],
      );

      await writeLbAuditLog(client, {
        workspaceOwnerId: wreq.workspaceOwnerId,
        actorId,
        accountId: stmt.account_id,
        action: "sync_to_odoo",
        before: { odoo_sync_status: stmt.odoo_sync_status },
        after: { odoo_sync_status: newSyncStatus, synced: syncedN, total: totalN, failed: failedN },
        metadata: { statement_id: stmtId, journal_id: journalId },
      });
    });
  } finally {
    client.release();
  }

  logger.info(
    { statementId: stmtId, successCount, failCount },
    "lbBankRecon: Odoo sync complete",
  );

  res.json({
    success: failCount === 0,
    synced_count: successCount,
    failed_count: failCount,
    total_attempted: linesToSync.length,
    results: syncResults.map((r) => ({
      line_id: r.lineId,
      success: r.success,
      odoo_record_id: r.odooRecordId ?? null,
      error: r.error ?? null,
    })),
  });
  } finally {
    try {
      await releaseFingerprintLocks();
      await syncLockClient.query(
        `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
        [lockKey],
      );
    } finally {
      syncLockClient.release();
    }
  }
});

// ── POST /lb-bank-recon/statements/:id/reconcile ──────────────────────────────
// Marks the statement as reconciled after passing all server-side preconditions.
// Requires finance-manager approval — sync alone cannot mark a statement reconciled.

router.post("/lb-bank-recon/statements/:id/reconcile", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }
  if (!hasFinanceManagerApproval(wreq)) {
    res.status(403).json({ error: "Finance manager approval is required to reconcile a statement" });
    return;
  }

  const stmtId = parseInt(req.params.id, 10);
  if (isNaN(stmtId)) {
    res.status(400).json({ error: "Invalid statement id" });
    return;
  }

  const entity = await requireLebanonEntityFull(wreq.workspaceOwnerId, res);
  if (!entity) return;

  const stmtResult = await requireStatement(stmtId, wreq.workspaceOwnerId, res);
  if (!stmtResult) return;

  // Read-only lock: reject mutations when the period is already closed.
  if (await isPeriodClosedForStatement(stmtId, wreq.workspaceOwnerId)) {
    res.status(423).json({
      error: "Period is closed — this statement is read-only. Reopen the month to make changes.",
    });
    return;
  }

  if (stmtResult.reconciliation_status === "reconciled") {
    res.status(409).json({ error: "Statement is already reconciled" });
    return;
  }

  // Validate preconditions
  const checksResult = await db.query<{
    total_posted: string;
    unsynced: string;
    unclassified: string;
    open_exceptions: string;
  }>(
    `SELECT
       COUNT(l.id) FILTER (WHERE l.line_type = 'posted')                                AS total_posted,
       COUNT(l.id) FILTER (
         WHERE l.line_type = 'posted'
           AND NOT EXISTS (
             SELECT 1 FROM lb_bank_statement_odoo_syncs os
              WHERE os.line_id = l.id AND os.status = 'success'
           )
       )                                                                                AS unsynced,
       COUNT(l.id) FILTER (WHERE l.line_type = 'posted' AND l.classification IS NULL)  AS unclassified,
       COUNT(l.id) FILTER (WHERE l.line_type = 'posted' AND l.classification = 'unidentified') AS open_exceptions
     FROM lb_bank_statement_lines l
     WHERE l.statement_id = $1`,
    [stmtId],
  );

  const checks = checksResult.rows[0];
  const blockers: string[] = [];

  // Balance-check gate: reject reconciliation when the parser detected an imbalance.
  const stmtMeta = (stmtResult.metadata ?? {}) as Record<string, unknown>;
  const balanceCheckPassed = stmtMeta.balanceCheckPassed === true;
  const balanceDifference = typeof stmtMeta.balanceDifference === "number" ? stmtMeta.balanceDifference : null;
  if (balanceDifference !== null && balanceDifference !== 0 && !balanceCheckPassed) {
    blockers.push(
      `Statement balance does not reconcile (difference: ${balanceDifference}). Resolve the balance discrepancy before marking as reconciled.`,
    );
  }

  if (parseInt(checks.total_posted, 10) === 0) {
    blockers.push("Statement has no posted lines — nothing to reconcile");
  }
  if (parseInt(checks.unsynced, 10) > 0) {
    blockers.push(`${checks.unsynced} posted line(s) have not been successfully synced to Odoo`);
  }
  if (parseInt(checks.unclassified, 10) > 0) {
    blockers.push(`${checks.unclassified} posted line(s) have not been classified`);
  }
  if (parseInt(checks.open_exceptions, 10) > 0) {
    blockers.push(`${checks.open_exceptions} line(s) are still classified as 'unidentified/needs review'`);
  }

  // Upload/sync success is deliberately not reconciliation. Refresh Odoo's
  // authoritative state before changing Presentail's local statement state.
  if (blockers.length === 0) {
    const syncedOdooLines = await db.query<{ odoo_record_id: string | null }>(
      `SELECT os.odoo_record_id
         FROM lb_bank_statement_odoo_syncs os
         JOIN lb_bank_statement_lines l ON l.id = os.line_id
        WHERE l.statement_id = $1
          AND l.line_type = 'posted'
          AND os.status = 'success'
          AND os.odoo_record_id IS NOT NULL`,
      [stmtId],
    );
    const odooStatementLineIds = syncedOdooLines.rows
      .map((row) => Number(row.odoo_record_id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (
      new Set(odooStatementLineIds).size !== odooStatementLineIds.length ||
      odooStatementLineIds.length !== parseInt(checks.total_posted, 10)
    ) {
      blockers.push("Every posted line must have one valid unique Odoo statement-line ID before reconciliation");
    }
    if (blockers.length > 0) {
      // Keep this gate deterministic and avoid an unnecessary external call.
    } else {
      const connector = createConnector(entity);
      if (!connector.refreshOdooReconciliationState) {
        blockers.push("Odoo reconciliation state could not be refreshed");
      } else {
        try {
          const states = await connector.refreshOdooReconciliationState(odooStatementLineIds);
          const stateById = new Map(states.map((state) => [state.statementLineId, state]));
          const unreconciled = odooStatementLineIds.filter((id) => !stateById.get(id)?.isReconciled);
          if (unreconciled.length > 0 || states.length !== odooStatementLineIds.length) {
            blockers.push(`${unreconciled.length || (odooStatementLineIds.length - states.length)} synced Odoo statement line(s) are not reconciled`);
          }
        } catch (error) {
          blockers.push(
            `Unable to refresh Odoo reconciliation state: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
    }
  }

  if (blockers.length > 0) {
    res.status(422).json({ error: "Reconciliation preconditions not met", blockers });
    return;
  }

  const actorId = wreq.userId ?? "unknown";
  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      await client.query(
        `UPDATE lb_bank_statements
            SET reconciliation_status = 'reconciled',
                reconciled_by = $1,
                reconciled_at = now(),
                updated_at    = now()
          WHERE id = $2`,
        [actorId, stmtId],
      );

      await writeLbAuditLog(client, {
        workspaceOwnerId: wreq.workspaceOwnerId,
        actorId,
        accountId: stmtResult.account_id,
        action: "reconcile_statement",
        before: { reconciliation_status: stmtResult.reconciliation_status },
        after: { reconciliation_status: "reconciled", reconciled_by: actorId },
        metadata: { statement_id: stmtId },
      });
    });
  } finally {
    client.release();
  }

  res.json({ success: true, reconciliation_status: "reconciled" });
});

// ── PATCH /lb-bank-recon/statements/:statementId/lines/:lineId/classify ───────
// Classifies a statement line as matched, bank_fee, inter_account, etc.
// Every classification is written to the audit log.

router.patch(
  "/lb-bank-recon/statements/:statementId/lines/:lineId/classify",
  async (req, res) => {
    const wreq = workspace(req);
    if (!hasFinanceAccounting(wreq)) {
      res.status(403).json({ error: "Finance accounting access required" });
      return;
    }

    const statementId = parseInt(req.params.statementId, 10);
    const lineId = parseInt(req.params.lineId, 10);
    if (isNaN(statementId) || isNaN(lineId)) {
      res.status(400).json({ error: "Invalid statement or line id" });
      return;
    }

    const entity = await requireLebanonEntity(wreq, res);
    if (!entity) return;

    const { classification, reason } = req.body as {
      classification?: unknown;
      reason?: unknown;
    };

    if (!classification || typeof classification !== "string" || !VALID_CLASSIFICATIONS.has(classification)) {
      res.status(400).json({
        error: `classification must be one of: ${[...VALID_CLASSIFICATIONS].join(", ")}`,
      });
      return;
    }

    if (CLASSIFICATION_REQUIRES_REASON.has(classification)) {
      if (!reason || typeof reason !== "string" || !reason.trim()) {
        res.status(400).json({
          error: `A reason is required when classification is '${classification}'`,
        });
        return;
      }
    }

    // Verify the line belongs to the statement and workspace
    const lineResult = await db.query<LbBankStatementLineRow>(
      `SELECT l.*
         FROM lb_bank_statement_lines l
         JOIN lb_bank_statements s ON s.id = l.statement_id
        WHERE l.id = $1
          AND l.statement_id = $2
          AND s.workspace_owner_id = $3`,
      [lineId, statementId, wreq.workspaceOwnerId],
    );
    if (!lineResult.rowCount || lineResult.rowCount === 0) {
      res.status(404).json({ error: "Statement line not found" });
      return;
    }

    // Read-only lock: reject mutations when the period is already closed.
    if (await isPeriodClosedForStatement(statementId, wreq.workspaceOwnerId)) {
      res.status(423).json({
        error: "Period is closed — this statement is read-only. Reopen the month to make changes.",
      });
      return;
    }

    const line = lineResult.rows[0];
    const actorId = wreq.userId ?? "unknown";
    const reasonStr = reason && typeof reason === "string" ? reason.trim() : null;

    const client = await db.connect();
    try {
      await withTransaction(client, async () => {
        await client.query(
          `UPDATE lb_bank_statement_lines
              SET classification        = $1,
                  classification_reason = $2,
                  classified_by         = $3,
                  classified_at         = now()
            WHERE id = $4`,
          [classification, reasonStr, actorId, lineId],
        );

        await writeLbAuditLog(client, {
          workspaceOwnerId: wreq.workspaceOwnerId,
          actorId,
          accountId: null,
          action: "classify_line",
          before: {
            classification: line.classification,
            classification_reason: line.classification_reason,
          },
          after: { classification, classification_reason: reasonStr },
          metadata: { statement_id: statementId, line_id: lineId },
        });
      });
    } finally {
      client.release();
    }

    res.json({
      success: true,
      line_id: lineId,
      classification,
      classification_reason: reasonStr,
    });
  },
);

// ── GET /lb-bank-recon/summary ────────────────────────────────────────────────
// Workspace-level summary for the overview cards: total accounts, statements
// imported, transactions matched, and unresolved count for a given month/year.

router.get("/lb-bank-recon/summary", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }

  const entity = await requireLebanonEntity(wreq, res);
  if (!entity) return;

  const monthStr = req.query.month ? String(req.query.month) : null;
  const yearStr = req.query.year ? String(req.query.year) : null;
  const month = monthStr ? parseInt(monthStr, 10) : null;
  const year = yearStr ? parseInt(yearStr, 10) : null;

  if (!month || !year || isNaN(month) || isNaN(year)) {
    res.status(400).json({ error: "month and year query parameters are required" });
    return;
  }

  const [accountsResult, stmtResult] = await Promise.all([
    db.query<{ total_accounts: string }>(
      `SELECT COUNT(*) AS total_accounts
         FROM lb_bank_accounts
        WHERE workspace_owner_id = $1 AND is_active = true`,
      [wreq.workspaceOwnerId],
    ),
    db.query<{
      statements_imported: string;
      total_lines: string;
      matched_count: string;
      synced_count: string;
      unresolved_count: string;
      reconciled_count: string;
    }>(
      `SELECT
         COUNT(DISTINCT s.id)                                                         AS statements_imported,
         COUNT(l.id) FILTER (WHERE l.line_type = 'posted')                           AS total_lines,
         COUNT(l.id) FILTER (WHERE l.line_type = 'posted' AND l.is_matched = true)   AS matched_count,
         COUNT(os.id) FILTER (WHERE os.status = 'success')                           AS synced_count,
         COUNT(l.id) FILTER (
           WHERE l.line_type = 'posted'
             AND (l.classification IS NULL OR l.classification = 'unidentified')
         )                                                                            AS unresolved_count,
         COUNT(DISTINCT s.id) FILTER (WHERE s.reconciliation_status = 'reconciled')  AS reconciled_count
       FROM lb_bank_statements s
       JOIN lb_bank_accounts a ON a.id = s.account_id
       LEFT JOIN lb_bank_statement_lines l ON l.statement_id = s.id
       LEFT JOIN lb_bank_statement_odoo_syncs os ON os.line_id = l.id
       WHERE s.workspace_owner_id = $1
         AND a.is_active = true
          AND CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                   THEN substring(s.period_start from 7 for 4)::int END = $2
          AND CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                   THEN substring(s.period_start from 4 for 2)::int END = $3
          AND CASE WHEN s.period_end ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                   THEN substring(s.period_end from 7 for 4)::int END = $2
          AND CASE WHEN s.period_end ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                   THEN substring(s.period_end from 4 for 2)::int END = $3`,
      [wreq.workspaceOwnerId, year, month],
    ),
  ]);

  const { total_accounts } = accountsResult.rows[0] ?? { total_accounts: "0" };
  const s = stmtResult.rows[0] ?? {
    statements_imported: "0",
    total_lines: "0",
    matched_count: "0",
    synced_count: "0",
    unresolved_count: "0",
    reconciled_count: "0",
  };

  res.json({
    month,
    year,
    total_bank_accounts: parseInt(total_accounts, 10),
    statements_imported: parseInt(s.statements_imported, 10),
    total_transactions: parseInt(s.total_lines, 10),
    matched_count: parseInt(s.matched_count, 10),
    synced_count: parseInt(s.synced_count, 10),
    unresolved_count: parseInt(s.unresolved_count, 10),
    reconciled_statements: parseInt(s.reconciled_count, 10),
  });
});

// ── GET /lb-bank-recon/odoo-connection ────────────────────────────────────────
// Returns the Odoo connection health for the Lebanon entity and the last
// successful bank statement sync timestamp across all statements.

router.get("/lb-bank-recon/odoo-connection", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }

  const entityResult = await db.query<FinanceEntityRow>(
    `SELECT * FROM finance_entities
      WHERE workspace_owner_id = $1
        AND country = 'LB'
        AND is_active = true
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [wreq.workspaceOwnerId],
  );

  if (!entityResult.rowCount || entityResult.rowCount === 0) {
    res.json({
      entity_id: null,
      connected: false,
      configured: false,
      error: "No active Lebanon finance entity found",
      last_sync_at: null,
    });
    return;
  }

  const entity = entityResult.rows[0];
  const baseUrlResult = normaliseOdooBaseUrl(entity.odoo_base_url);
  const configured = entity.accounting_system === "odoo" &&
    baseUrlResult.ok &&
    !!(
      entity.odoo_base_url &&
      entity.odoo_database &&
      entity.odoo_company_id === LEBANON_ODOO_COMPANY_ID &&
      entity.odoo_company_name?.trim() === LEBANON_ODOO_COMPANY_NAME &&
      process.env.ODOO_API_KEY
    );

  // Last successful sync across all LB statements in this workspace
  const lastSyncResult = await db.query<{ last_sync_at: string | null }>(
    `SELECT MAX(os.synced_at) AS last_sync_at
       FROM lb_bank_statement_odoo_syncs os
       JOIN lb_bank_statement_lines l ON l.id = os.line_id
       JOIN lb_bank_statements s ON s.id = l.statement_id
      WHERE s.workspace_owner_id = $1
        AND os.status = 'success'`,
    [wreq.workspaceOwnerId],
  );
  const lastSyncAt = lastSyncResult.rows[0]?.last_sync_at ?? null;
  const mappingsResult = await db.query<{ odoo_journal_id: number | null; odoo_journal_name: string | null }>(
    `SELECT odoo_journal_id, odoo_journal_name
       FROM lb_bank_accounts
      WHERE workspace_owner_id = $1
        AND is_active = true
        AND odoo_journal_id IS NOT NULL`,
    [wreq.workspaceOwnerId],
  );
  const configuredMappings = mappingsResult.rows;

  if (!configured) {
    res.json({
      entity_id: entity.id,
      connected: false,
      configured: false,
      accounting_system: entity.accounting_system,
      legal_name: entity.legal_name,
      display_name: entity.display_name,
      odoo_base_url: sanitiseOdooBaseUrlForResponse(entity.odoo_base_url),
      odoo_database: entity.odoo_database,
      odoo_company_id: entity.odoo_company_id,
      odoo_company_name: entity.odoo_company_name,
      error: "Configure Presentail SAL (Odoo company 2), database, URL, and the server ODOO_API_KEY secret.",
      last_sync_at: lastSyncAt,
    });
    return;
  }

  // Probe Odoo through read-only JSON-2 calls.  The entity's legacy
  // integration token is intentionally not used for bank reconciliation.
  const baseUrl = baseUrlResult.ok ? baseUrlResult.url : "";
  let connected = false;
  let connectionError: string | null = null;
  let diagnostics: Record<string, unknown> | null = null;
  let journals: unknown[] = [];

  try {
    const client = new OdooJson2Client({
      baseUrl,
      database: entity.odoo_database!,
      companyId: entity.odoo_company_id!,
    });
    const result = await client.diagnostics();
    diagnostics = {
      context: result.context,
      company: result.company,
      access: result.access,
    };
    journals = result.journals;
    const companyName = String(result.company?.name ?? "").trim();
    const companyMatches = Number(result.company?.id) === entity.odoo_company_id &&
      (!entity.odoo_company_name || companyName === entity.odoo_company_name.trim());
    const permissionsOk = Object.values(result.access).every((value) => value !== false);
    const journalById = new Map(result.journals.map((journal) => [journal.id, journal]));
    const staleMapping = configuredMappings.find((mapping) => {
      const journal = journalById.get(Number(mapping.odoo_journal_id));
      return !journal || (mapping.odoo_journal_name && mapping.odoo_journal_name !== journal.name);
    });
    connected = companyMatches && permissionsOk &&
      result.journals.length > 0 &&
      !staleMapping &&
      result.journals.every((journal) => journal.company_id === entity.odoo_company_id);
    if (!companyMatches) connectionError = "Configured Odoo company was not found or does not match the selected Presentail entity.";
    else if (!permissionsOk) connectionError = "Odoo JSON-2 permissions are insufficient for bank reconciliation.";
    else if (result.journals.length === 0) connectionError = "No active Odoo bank journals were found for the configured company.";
    else if (staleMapping) connectionError = "A configured bank journal is missing, inactive, or has changed in Odoo.";
  } catch (err) {
    connectionError = getOdooJson2DiagnosticError(err);
    logger.warn(
      { ...getOdooNetworkErrorLogDetails(err), workspaceOwnerId: wreq.workspaceOwnerId },
      "lbBankRecon: Odoo health check failed",
    );
  }

  res.json({
    entity_id: entity.id,
    connected,
    configured: true,
    accounting_system: entity.accounting_system,
    legal_name: entity.legal_name,
    display_name: entity.display_name,
    odoo_base_url: sanitiseOdooBaseUrlForResponse(baseUrl),
    odoo_database: entity.odoo_database,
    odoo_company_id: entity.odoo_company_id,
    odoo_company_name: entity.odoo_company_name,
    error: connectionError,
    last_sync_at: lastSyncAt,
    diagnostics,
    journals,
  });
});

// ── GET /lb-bank-recon/odoo-journals ─────────────────────────────────────────
// Read-only journal discovery for account mapping.  The response is kept as a
// stable, deliberately narrow contract so the client never needs Odoo model
// details or credentials.

router.get("/lb-bank-recon/odoo-journals", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }

  const entity = await requireLebanonEntityFull(wreq.workspaceOwnerId, res);
  if (!entity) return;
  const base = normaliseOdooBaseUrl(entity.odoo_base_url);
  if (
    entity.accounting_system !== "odoo" ||
    !base.ok ||
    !entity.odoo_database ||
    entity.odoo_company_id !== LEBANON_ODOO_COMPANY_ID ||
    entity.odoo_company_name?.trim() !== LEBANON_ODOO_COMPANY_NAME ||
    !process.env.ODOO_API_KEY
  ) {
    res.status(422).json({
      journals: [],
      count: 0,
      error: "Configure the Lebanon Odoo URL, database, company, and ODOO_API_KEY secret first.",
    });
    return;
  }

  try {
    const client = new OdooJson2Client({
      baseUrl: base.url,
      database: entity.odoo_database,
      companyId: entity.odoo_company_id,
    });
    const journals = await client.getJournals();
    res.json({ journals, count: journals.length });
  } catch (err) {
    const error = getOdooJson2DiagnosticError(err);
    logger.warn({ workspaceOwnerId: wreq.workspaceOwnerId, error }, "lbBankRecon: journal discovery failed");
    res.status(502).json({ journals: [], count: 0, error });
  }
});

// Read Odoo's reconciliation state separately from Presentail's upload and
// classification state.  Upload success must never be treated as a match.
router.post("/lb-bank-recon/statements/:id/odoo-reconciliation-refresh", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }
  const statementId = parseInt(req.params.id, 10);
  if (isNaN(statementId)) {
    res.status(400).json({ error: "Invalid statement id" });
    return;
  }
  const entity = await requireLebanonEntityFull(wreq.workspaceOwnerId, res);
  if (!entity) return;
  if (
    entity.odoo_company_id !== LEBANON_ODOO_COMPANY_ID ||
    entity.odoo_company_name?.trim() !== LEBANON_ODOO_COMPANY_NAME
  ) {
    res.status(422).json({ error: "Configured Odoo company must be Presentail SAL (company 2)." });
    return;
  }
  const statement = await requireStatement(statementId, wreq.workspaceOwnerId, res);
  if (!statement) return;
  const syncs = await db.query<{ odoo_record_id: string | null }>(
    `SELECT os.odoo_record_id
       FROM lb_bank_statement_odoo_syncs os
       JOIN lb_bank_statement_lines l ON l.id = os.line_id
      WHERE l.statement_id = $1
        AND l.line_type = 'posted'
        AND os.status = 'success'
        AND os.odoo_record_id IS NOT NULL`,
    [statementId],
  );
  const ids = syncs.rows
    .map((row) => Number(row.odoo_record_id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const connector = createConnector(entity);
  if (!connector.refreshOdooReconciliationState) {
    res.status(501).json({ error: "Odoo reconciliation refresh is unavailable" });
    return;
  }
  try {
    const states = await connector.refreshOdooReconciliationState(ids);
    res.json({ statement_id: statementId, states });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "Unable to refresh Odoo reconciliation state",
    });
  }
});

// Explicit reviewer action for standard Odoo reconciliation.  The caller must
// provide the exact account.move.line IDs; no automatic matching is attempted.
router.post("/lb-bank-recon/statements/:id/odoo-reconcile", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }
  if (!hasFinanceManagerApproval(wreq)) {
    res.status(403).json({ error: "Finance manager approval is required for Odoo reconciliation" });
    return;
  }
  const statementId = parseInt(req.params.id, 10);
  if (isNaN(statementId)) {
    res.status(400).json({ error: "Invalid statement id" });
    return;
  }
  const entity = await requireLebanonEntityFull(wreq.workspaceOwnerId, res);
  if (!entity) return;
  if (
    entity.odoo_company_id !== LEBANON_ODOO_COMPANY_ID ||
    entity.odoo_company_name?.trim() !== LEBANON_ODOO_COMPANY_NAME
  ) {
    res.status(422).json({ error: "Configured Odoo company must be Presentail SAL (company 2)." });
    return;
  }
  if (await isPeriodClosedForStatement(statementId, wreq.workspaceOwnerId)) {
    res.status(423).json({ error: "Period is closed — this statement is read-only. Reopen the month to make changes." });
    return;
  }
  const statement = await requireStatement(statementId, wreq.workspaceOwnerId, res);
  if (!statement) return;
  const rawIds = (req.body as Record<string, unknown>)?.move_line_ids;
  if (!Array.isArray(rawIds)) {
    res.status(400).json({ error: "move_line_ids must be an array of Odoo account.move.line IDs" });
    return;
  }
  const moveLineIds = rawIds.map((id) => Number(id));
  if (moveLineIds.length < 2 || moveLineIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    res.status(400).json({ error: "At least two valid move_line_ids are required" });
    return;
  }
  if (new Set(moveLineIds).size !== moveLineIds.length) {
    res.status(422).json({ error: "Duplicate move_line_ids are not allowed" });
    return;
  }
  const synced = await db.query<{ odoo_record_id: string | null }>(
    `SELECT os.odoo_record_id
       FROM lb_bank_statement_odoo_syncs os
       JOIN lb_bank_statement_lines l ON l.id = os.line_id
      WHERE l.statement_id = $1
        AND l.line_type = 'posted'
        AND os.status = 'success'
        AND os.odoo_record_id IS NOT NULL`,
    [statementId],
  );
  const syncedStatementLineIds = synced.rows
    .map((row) => Number(row.odoo_record_id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (new Set(syncedStatementLineIds).size !== syncedStatementLineIds.length) {
    res.status(422).json({ error: "This statement has duplicate Odoo statement-line IDs and cannot be reconciled safely." });
    return;
  }
  const otherSynced = await db.query<{ odoo_record_id: string | null }>(
    `SELECT DISTINCT os.odoo_record_id
       FROM lb_bank_statement_odoo_syncs os
       JOIN lb_bank_statement_lines l ON l.id = os.line_id
       JOIN lb_bank_statements s ON s.id = l.statement_id
      WHERE s.workspace_owner_id = $1
        AND s.id <> $2
        AND os.status = 'success'
        AND os.odoo_record_id IS NOT NULL`,
    [wreq.workspaceOwnerId, statementId],
  );
  const otherStatementLineIds = otherSynced.rows
    .map((row) => Number(row.odoo_record_id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const connector = createConnector(entity);
  if (
    !connector.refreshOdooReconciliationState ||
    !connector.reconcileOdooMoveLines ||
    !connector.validateOdooMoveLineSelection
  ) {
    res.status(501).json({ error: "Odoo reconciliation is unavailable" });
    return;
  }
  try {
    const states = await connector.refreshOdooReconciliationState(syncedStatementLineIds);
    const otherStates = await connector.refreshOdooReconciliationState(otherStatementLineIds);
    const otherMoveLineIds = new Set(otherStates.flatMap((state) => state.moveLineIds));
    const eligibleStatementSide = new Set(
      states.flatMap((state) => state.unreconciledStatementSideEligibleMoveLineIds ?? []),
    );
    const selectedStatementSide = moveLineIds.filter((id) => eligibleStatementSide.has(id));
    const selectedCounterparts = moveLineIds.filter((id) => !eligibleStatementSide.has(id));
    if (selectedStatementSide.length !== 1 || selectedCounterparts.length < 1) {
      res.status(422).json({
        error: "Select exactly one eligible statement-side item and at least one validated external counterpart.",
      });
      return;
    }
    if (moveLineIds.some((id) => otherMoveLineIds.has(id))) {
      res.status(422).json({ error: "A selected move line belongs to another synced statement." });
      return;
    }
    const selectedDetails = await connector.validateOdooMoveLineSelection(moveLineIds);
    const detailsById = new Map(selectedDetails.map((detail) => [detail.id, detail]));
    if (
      selectedDetails.length !== moveLineIds.length ||
      selectedDetails.some((detail) =>
        detail.company_id !== LEBANON_ODOO_COMPANY_ID ||
        detail.reconciled ||
        !detail.reconcilable ||
        detail.account_id == null,
      ) ||
      selectedDetails.some((detail, index, details) => index > 0 && detail.account_id !== details[0].account_id) ||
      selectedCounterparts.some((id) => {
        const detail = detailsById.get(id);
        return !detail;
      })
    ) {
      res.status(422).json({ error: "Select exactly one statement-side item plus validated external counterparts: every selected line must exist in Presentail SAL, be unreconciled/reconcilable, and use the same account." });
      return;
    }
    const result = await connector.reconcileOdooMoveLines(moveLineIds);
    res.json({ success: true, statement_id: statementId, move_line_ids: moveLineIds, result });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "Unable to reconcile Odoo journal items",
    });
  }
});


// ── Period-close lock helper ──────────────────────────────────────────────────
// Returns true when the accounting_entity_month for the Lebanon entity
// that covers the given statement's period is currently closed.
// Uses period_start (DD/MM/YYYY) to determine year/month.
// Returns false if period_start is NULL or no entity-month record exists.

async function isPeriodClosedForStatement(
  statementId: number,
  workspaceOwnerId: string,
): Promise<boolean> {
  const result = await db.query<{ status: string }>(
    `SELECT aem.status
       FROM lb_bank_statements s
       JOIN lb_bank_accounts a ON a.id = s.account_id
       JOIN finance_entities fe
         ON fe.workspace_owner_id = a.workspace_owner_id
        AND fe.country = 'LB'
        AND fe.is_active = true
       JOIN accounting_months am
         ON am.workspace_owner_id = a.workspace_owner_id
         AND am.year = CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                            THEN substring(s.period_start from 7 for 4)::int END
         AND am.month = CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                              THEN substring(s.period_start from 4 for 2)::int END
       JOIN accounting_entity_months aem
         ON aem.accounting_month_id = am.id
        AND aem.entity_id = fe.id
      WHERE s.id = $1 AND s.workspace_owner_id = $2
         AND s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
      LIMIT 1`,
    [statementId, workspaceOwnerId],
  );
  return result.rows[0]?.status === "closed";
}

// ── Statement upload configuration ────────────────────────────────────────────

const STATEMENT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: STATEMENT_MAX_SIZE_BYTES },
});

const ALLOWED_EXTENSIONS = new Set([".xls", ".xlsx", ".csv"]);

// Browsers vary in what MIME type they send for .xls; accept common variants.
const ALLOWED_MIME_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  "application/csv",
  "application/octet-stream", // some browsers send this for legacy .xls
]);

// ── Statement preview types ───────────────────────────────────────────────────

interface StatementLinePreview {
  id: number;
  businessDate: string;
  valueDate: string;
  narrative: string;
  details: string;
  transactionRef: string;
  debitAmount: string | null;
  creditAmount: string | null;
  balance: string | null;
  currency: string;
  lineType: string; // "posted" | "excluded"
  fingerprint: string | null;
  sourceRowIndex: number;
}

interface ParsedStatementPreview {
  statementId: number;
  accountId: number;
  bankName: string;
  accountName: string;
  currency: string;
  originalFilename: string;
  periodStart: string;
  periodEnd: string;
  accountType: string;
  maskedAccountNumber: string;
  openingBalance: number;
  closingBalance: number;
  moneyReceived: number;
  moneyPaid: number;
  balanceDifference: number;
  balanceCheckPassed: boolean;
  postedCount: number;
  pendingCount: number;
  lines: StatementLinePreview[];
}

// ── Object storage helper ─────────────────────────────────────────────────────

async function uploadStatementToStorage(
  buffer: Buffer,
  originalFilename: string,
  workspaceOwnerId: string,
  mimeType: string,
): Promise<string> {
  const privateObjectDir = objectStorageService.getPrivateObjectDir();
  const objectId = randomUUID();
  const entityPath = `${workspaceOwnerId}/lb-bank-statements/${objectId}/${originalFilename}`;
  const fullPath = privateObjectDir.endsWith("/")
    ? `${privateObjectDir}${entityPath}`
    : `${privateObjectDir}/${entityPath}`;

  const parts = fullPath.startsWith("/")
    ? fullPath.slice(1).split("/")
    : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");

  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");

  await objectStorageClient
    .bucket(bucketName)
    .file(objectName)
    .save(buffer, { contentType: mimeType, resumable: false });

  return `/objects/${entityPath}`;
}

// ── POST /lb-bank-recon/statements/upload ────────────────────────────────────

router.post(
  "/lb-bank-recon/statements/upload",
  statementUpload.single("statement"),
  async (req, res) => {
    const wreq = workspace(req);
    if (!hasFinanceAccounting(wreq)) {
      res.status(403).json({ error: "Finance accounting access required" });
      return;
    }

    const entity = await requireLebanonEntity(wreq, res);
    if (!entity) return;

    // ── Validate uploaded file ──────────────────────────────────────────────
    if (!req.file) {
      res.status(400).json({
        error: "No file uploaded (expected multipart field name: statement)",
      });
      return;
    }

    const originalFilename = req.file.originalname ?? "statement";
    const lastDot = originalFilename.lastIndexOf(".");
    const ext = lastDot >= 0 ? originalFilename.slice(lastDot).toLowerCase() : "";

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({
        error: `Invalid file extension "${ext}". Allowed extensions: .xls, .xlsx, .csv`,
      });
      return;
    }

    const mime = (req.file.mimetype ?? "").toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mime)) {
      res.status(400).json({
        error: `Invalid MIME type "${mime}" for a bank statement file`,
      });
      return;
    }

    if (!req.file.buffer?.length) {
      res.status(400).json({ error: "Uploaded file is empty" });
      return;
    }

    // CSV parser is planned but not yet implemented
    if (ext === ".csv") {
      res.status(422).json({
        error: "CSV bank statement parsing is not yet supported",
      });
      return;
    }

    // ── Validate account_id ─────────────────────────────────────────────────
    const accountIdRaw = (req.body as Record<string, unknown>)?.account_id;
    const accountId = accountIdRaw ? parseInt(String(accountIdRaw), 10) : NaN;
    if (isNaN(accountId)) {
      res.status(400).json({ error: "account_id is required" });
      return;
    }

    const accountResult = await db.query<LbBankAccountRow>(
      `SELECT * FROM lb_bank_accounts
        WHERE id = $1 AND workspace_owner_id = $2 AND is_active = true`,
      [accountId, wreq.workspaceOwnerId],
    );
    if (!accountResult.rowCount) {
      res.status(404).json({ error: "Bank account not found" });
      return;
    }
    const account = accountResult.rows[0];

    // ── Duplicate detection — SHA-256 checked before any parsing ───────────
    const fileHash = createHash("sha256").update(req.file.buffer).digest("hex");

    const dupCheck = await db.query<{ id: number }>(
      `SELECT id FROM lb_bank_statements
        WHERE account_id = $1 AND file_hash = $2 LIMIT 1`,
      [accountId, fileHash],
    );
    if (dupCheck.rowCount && dupCheck.rowCount > 0) {
      res.status(409).json({
        error: "Duplicate file: this statement has already been uploaded",
        existingStatementId: dupCheck.rows[0].id,
      });
      return;
    }

    // ── Parse — no DB rows are created if the parser throws ────────────────
    let parseResult: Awaited<ReturnType<typeof parseBLOMBuffer>>;
    try {
      parseResult = await parseBLOMBuffer(req.file.buffer);
    } catch (err: unknown) {
      if (err instanceof BLOMParseError) {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }

    // ── Period-close lock: reject upload when the period is already closed ──
    // Parse year/month from DD/MM/YYYY period_start before creating any rows.
    {
      const parts = parseResult.periodStart.split("/");
      const periodYear = parts[2] ? parseInt(parts[2], 10) : NaN;
      const periodMonth = parts[1] ? parseInt(parts[1], 10) : NaN;
      if (!isNaN(periodYear) && !isNaN(periodMonth)) {
        const closedCheck = await db.query<{ status: string }>(
          `SELECT aem.status
             FROM finance_entities fe
             JOIN accounting_months am ON am.workspace_owner_id = fe.workspace_owner_id
               AND am.year = $1 AND am.month = $2
             JOIN accounting_entity_months aem ON aem.accounting_month_id = am.id
               AND aem.entity_id = fe.id
            WHERE fe.workspace_owner_id = $3
              AND fe.country = 'LB'
              AND fe.is_active = true
            LIMIT 1`,
          [periodYear, periodMonth, wreq.workspaceOwnerId],
        );
        if (closedCheck.rows[0]?.status === "closed") {
          res.status(423).json({
            error: "Period is closed — this statement is read-only. Reopen the month to make changes.",
          });
          return;
        }
      }
    }

    // ── Upload file to object storage ───────────────────────────────────────
    let storagePath: string;
    try {
      storagePath = await uploadStatementToStorage(
        req.file.buffer,
        originalFilename,
        wreq.workspaceOwnerId,
        mime || "application/vnd.ms-excel",
      );
    } catch (err) {
      logger.error({ err, accountId }, "lb-bank-recon: failed to upload statement file");
      res.status(502).json({ error: "Failed to store the uploaded file" });
      return;
    }

    // ── Insert statement + lines in a single transaction ────────────────────
    const uploadedBy = wreq.userId ?? "unknown";

    const statementMeta = {
      currency: parseResult.currency,
      accountType: parseResult.accountType,
      maskedAccountNumber: parseResult.maskedAccountNumber,
      openingBalance: parseResult.openingBalance,
      closingBalance: parseResult.closingBalance,
      moneyReceived: parseResult.moneyReceived,
      moneyPaid: parseResult.moneyPaid,
      balanceDifference: parseResult.balanceDifference,
      balanceCheckPassed: parseResult.balanceCheckPassed,
    };

    // Flatten posted + pending rows into a single ordered list
    const allLines = [
      ...parseResult.postedRows.map((r) => ({
        lineType: "posted" as const,
        businessDate: r.businessDate,
        valueDate: r.valueDate,
        narrative: r.narrative,
        details: r.details,
        transactionRef: r.transactionRef,
        debitAmount: r.debitAmount,
        creditAmount: r.creditAmount,
        balance: r.realtimeBalance as number | null,
        sourceRowIndex: r.sourceRowIndex,
      })),
      ...parseResult.pendingRows.map((r) => ({
        lineType: "excluded" as const,
        businessDate: r.businessDate,
        valueDate: r.valueDate,
        narrative: r.narrative,
        details: r.details,
        transactionRef: r.transactionRef,
        debitAmount: r.debitAmount,
        creditAmount: r.creditAmount,
        balance: null as null,
        sourceRowIndex: r.sourceRowIndex,
      })),
    ];

    const client = await db.connect();

    let statementId!: number;
    const insertedLines: StatementLinePreview[] = [];

    try {
      await withTransaction(client, async () => {
        // 1. Insert statement header row
        const stmtResult = await client.query<{ id: number }>(
          `INSERT INTO lb_bank_statements
             (workspace_owner_id, account_id, original_filename, storage_path,
              file_hash, period_start, period_end, status, uploaded_by, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'uploaded',$8,$9)
           RETURNING id`,
          [
            wreq.workspaceOwnerId,
            accountId,
            originalFilename,
            storagePath,
            fileHash,
            parseResult.periodStart,
            parseResult.periodEnd,
            uploadedBy,
            JSON.stringify(statementMeta),
          ],
        );
        statementId = stmtResult.rows[0].id;

        // 2. Insert each line
        for (const line of allLines) {
          const fingerprint = computeLineFingerprint({
            accountId,
            periodStart: parseResult.periodStart,
            periodEnd: parseResult.periodEnd,
            businessDate: line.businessDate,
            valueDate: line.valueDate,
            debitAmount: line.debitAmount,
            creditAmount: line.creditAmount,
            narrative: line.narrative,
            transactionRef: line.transactionRef,
            realtimeBalance: line.balance,
            sourceRowIndex: line.sourceRowIndex,
          });

          const lineResult = await client.query<{ id: number }>(
            `INSERT INTO lb_bank_statement_lines
               (statement_id, workspace_owner_id, line_date, value_date, description,
                reference, debit_amount, credit_amount, balance, currency,
                line_type, fingerprint, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING id`,
            [
              statementId,
              wreq.workspaceOwnerId,
              line.businessDate,
              line.valueDate,
              line.narrative,
              line.transactionRef,
              line.debitAmount !== null ? String(line.debitAmount) : null,
              line.creditAmount !== null ? String(line.creditAmount) : null,
              line.balance !== null ? String(line.balance) : null,
              parseResult.currency,
              line.lineType,
              fingerprint,
              JSON.stringify({ details: line.details, sourceRowIndex: line.sourceRowIndex }),
            ],
          );

          insertedLines.push({
            id: lineResult.rows[0].id,
            businessDate: line.businessDate,
            valueDate: line.valueDate,
            narrative: line.narrative,
            details: line.details,
            transactionRef: line.transactionRef,
            debitAmount: line.debitAmount !== null ? String(line.debitAmount) : null,
            creditAmount: line.creditAmount !== null ? String(line.creditAmount) : null,
            balance: line.balance !== null ? String(line.balance) : null,
            currency: parseResult.currency,
            lineType: line.lineType,
            fingerprint,
            sourceRowIndex: line.sourceRowIndex,
          });
        }
      });
    } finally {
      client.release();
    }

    // ── Build preview response ──────────────────────────────────────────────
    const postedLines = insertedLines.filter((l) => l.lineType === "posted");
    const pendingLines = insertedLines.filter((l) => l.lineType === "excluded");

    const preview: ParsedStatementPreview = {
      statementId,
      accountId,
      bankName: account.bank_name,
      accountName: account.account_name,
      currency: parseResult.currency,
      originalFilename,
      periodStart: parseResult.periodStart,
      periodEnd: parseResult.periodEnd,
      accountType: parseResult.accountType,
      maskedAccountNumber: parseResult.maskedAccountNumber,
      openingBalance: parseResult.openingBalance,
      closingBalance: parseResult.closingBalance,
      moneyReceived: parseResult.moneyReceived,
      moneyPaid: parseResult.moneyPaid,
      balanceDifference: parseResult.balanceDifference,
      balanceCheckPassed: parseResult.balanceCheckPassed,
      postedCount: postedLines.length,
      pendingCount: pendingLines.length,
      lines: insertedLines,
    };

    res.status(201).json({ preview });
  },
);

// ── GET /lb-bank-recon/statements/:id/preview ─────────────────────────────────

router.get("/lb-bank-recon/statements/:id/preview", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance accounting access required" });
    return;
  }

  const entity = await requireLebanonEntity(wreq, res);
  if (!entity) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid statement id" });
    return;
  }

  // Load statement + account info in one query
  const stmtResult = await db.query<{
    id: number;
    account_id: number;
    original_filename: string | null;
    period_start: string | null;
    period_end: string | null;
    metadata: Record<string, unknown>;
    bank_name: string;
    account_name: string;
  }>(
    `SELECT s.id, s.account_id, s.original_filename, s.period_start, s.period_end,
            s.metadata, a.bank_name, a.account_name
       FROM lb_bank_statements s
       JOIN lb_bank_accounts a ON a.id = s.account_id
      WHERE s.id = $1 AND s.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (!stmtResult.rowCount) {
    res.status(404).json({ error: "Statement not found" });
    return;
  }

  const stmt = stmtResult.rows[0];
  const meta = (stmt.metadata ?? {}) as Record<string, unknown>;

  // Load all lines ordered by insertion sequence
  const linesResult = await db.query<{
    id: number;
    line_date: string | null;
    value_date: string | null;
    description: string | null;
    reference: string | null;
    debit_amount: string | null;
    credit_amount: string | null;
    balance: string | null;
    currency: string;
    line_type: string;
    fingerprint: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, line_date, value_date, description, reference,
            debit_amount, credit_amount, balance, currency,
            line_type, fingerprint, metadata
       FROM lb_bank_statement_lines
      WHERE statement_id = $1
      ORDER BY id ASC`,
    [id],
  );

  const lines: StatementLinePreview[] = linesResult.rows.map((l) => {
    const lm = (l.metadata ?? {}) as Record<string, unknown>;
    return {
      id: l.id,
      businessDate: l.line_date ?? "",
      valueDate: l.value_date ?? "",
      narrative: l.description ?? "",
      details: typeof lm.details === "string" ? lm.details : "",
      transactionRef: l.reference ?? "",
      debitAmount: l.debit_amount,
      creditAmount: l.credit_amount,
      balance: l.balance,
      currency: l.currency,
      lineType: l.line_type,
      fingerprint: l.fingerprint,
      sourceRowIndex:
        typeof lm.sourceRowIndex === "number" ? lm.sourceRowIndex : 0,
    };
  });

  const postedLines = lines.filter((l) => l.lineType === "posted");
  const pendingLines = lines.filter((l) => l.lineType === "excluded");

  const preview: ParsedStatementPreview = {
    statementId: stmt.id,
    accountId: stmt.account_id,
    bankName: stmt.bank_name,
    accountName: stmt.account_name,
    currency: typeof meta.currency === "string" ? meta.currency : "LBP",
    originalFilename: stmt.original_filename ?? "",
    periodStart: stmt.period_start ?? "",
    periodEnd: stmt.period_end ?? "",
    accountType: typeof meta.accountType === "string" ? meta.accountType : "",
    maskedAccountNumber:
      typeof meta.maskedAccountNumber === "string" ? meta.maskedAccountNumber : "",
    openingBalance: typeof meta.openingBalance === "number" ? meta.openingBalance : 0,
    closingBalance: typeof meta.closingBalance === "number" ? meta.closingBalance : 0,
    moneyReceived: typeof meta.moneyReceived === "number" ? meta.moneyReceived : 0,
    moneyPaid: typeof meta.moneyPaid === "number" ? meta.moneyPaid : 0,
    balanceDifference:
      typeof meta.balanceDifference === "number" ? meta.balanceDifference : 0,
    balanceCheckPassed: meta.balanceCheckPassed === true,
    postedCount: postedLines.length,
    pendingCount: pendingLines.length,
    lines,
  };

  res.json({ preview });
});

export default router;
