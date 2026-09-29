import { Router } from "express";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { hasPageAccess, resolveWorkspace, workspace } from "../lib/workspace";
import {
  buildStepSchedule,
  calculateNextRun,
  normalizeJourneySteps,
  nextCycleAt,
  parseIsoDate,
  periodForCycle,
  periodLabelForDates,
  type StatementCadence,
} from "../lib/supplierStatementCollection";
import { markSupplierStatementReceivedById, supplierStatementProviderReadiness } from "../lib/supplierStatementDelivery";
import { normalizePhoneForCountry } from "../lib/respondio";

const router = Router();
const collectionPaths = [
  "/supplier-statement-contacts",
  "/supplier-statement-journeys",
  "/supplier-statement-schedules",
  "/supplier-statement-requests",
  "/supplier-statement-readiness",
];
for (const path of collectionPaths) router.use(path, requireAuth, resolveWorkspace);

type Wreq = ReturnType<typeof workspace>;
type JsonRecord = Record<string, unknown>;
const CADENCES = new Set<StatementCadence>(["monthly", "quarterly"]);

function canRead(wreq: Wreq): boolean {
  return hasPageAccess(wreq, "supplier-statements") || hasPageAccess(wreq, "suppliers") || hasPageAccess(wreq, "finance");
}
function canWrite(wreq: Wreq): boolean {
  return hasPageAccess(wreq, "supplier-statements.edit") ||
    hasPageAccess(wreq, "supplier-statements.create") ||
    hasPageAccess(wreq, "suppliers.edit") ||
    hasPageAccess(wreq, "finance.edit");
}
function deny(res: Parameters<Parameters<typeof router.get>[1]>[1], message = "Supplier statement access required"): void {
  res.status(403).json({ error: message });
}
function body(req: { body?: unknown }): JsonRecord {
  return req.body && typeof req.body === "object" ? req.body as JsonRecord : {};
}
function jsonRecord(value: unknown): JsonRecord {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function normalizeSupplierContactPhone(value: unknown): { raw: string | null; normalized: string | null } {
  const raw = optionalString(value);
  return { raw, normalized: raw ? normalizePhoneForCountry(raw) : null };
}
function requireDate(value: unknown, field: string): string {
  const parsed = parseIsoDate(value);
  if (!parsed) throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  return parsed;
}
function requireDateTime(value: unknown, field: string): Date {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
    !parseIsoDate(value.slice(0, 10))
  ) {
    throw new Error(`${field} must be a valid ISO date-time with a timezone`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be a valid ISO date-time with a timezone`);
  return parsed;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid request";
}
function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505";
}
function asJson(value: unknown): unknown {
  return value ?? {};
}
function jsonbParam(value: unknown): string {
  return JSON.stringify(value ?? {});
}

async function supplierExists(ownerId: string, supplierId: number): Promise<boolean> {
  const result = await db.query("SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false", [supplierId, ownerId]);
  return (result.rowCount ?? 0) > 0;
}
async function entityExists(ownerId: string, entityId: number): Promise<boolean> {
  const result = await db.query("SELECT id FROM finance_entities WHERE id = $1 AND workspace_owner_id = $2 AND is_active = true", [entityId, ownerId]);
  return (result.rowCount ?? 0) > 0;
}
async function writeAudit(ownerId: string, entityType: string, entityId: string, action: string, actorId: string | null, metadata: unknown = {}): Promise<void> {
  await db.query(
    `INSERT INTO supplier_statement_audit_events
       (workspace_owner_id, entity_type, entity_id, action, actor_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ownerId, entityType, entityId, action, actorId, jsonbParam(metadata)],
  );
}

function normalizeRecipients(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(numberValue).filter((id): id is number => id !== null))];
}

async function approvedRecipientCount(ownerId: string, supplierId: number, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.query(
    `SELECT count(*)::int AS count
       FROM supplier_statement_contacts
      WHERE workspace_owner_id=$1 AND supplier_id=$2 AND id=ANY($3::int[])
        AND is_active=true AND is_approved=true`,
    [ownerId, supplierId, ids],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function getApprovedRecipients(ownerId: string, supplierId: number, requestedIds?: number[]): Promise<Array<Record<string, unknown>>> {
  const values: unknown[] = [ownerId, supplierId];
  let filter = "";
  if (requestedIds && requestedIds.length > 0) {
    values.push(requestedIds);
    filter = ` AND c.id = ANY($${values.length}::int[])`;
  } else {
    filter = " AND c.is_selected = true";
  }
  const result = await db.query(
    `SELECT c.id, c.name, c.role, c.department, c.email, c.phone, c.whatsapp_phone,
            c.provenance, c.is_approved, c.is_selected, c.is_active
       FROM supplier_statement_contacts c
      WHERE c.workspace_owner_id = $1 AND c.supplier_id = $2
        AND c.is_active = true AND c.is_approved = true
        ${filter}
      ORDER BY c.name ASC, c.id ASC`,
    values,
  );
  return result.rows;
}

async function getJourneySnapshot(ownerId: string, journeyId: number | null, recipientIds: number[], supplierId: number): Promise<{
  journeyVersionId: number | null;
  journeySnapshot: JsonRecord;
  recipients: Array<Record<string, unknown>>;
  needsSetup: boolean;
}> {
  let recipients = await getApprovedRecipients(ownerId, supplierId, recipientIds);
  if (!journeyId) {
    return { journeyVersionId: null, journeySnapshot: {}, recipients, needsSetup: true };
  }
  const journey = await db.query(
    `SELECT j.id, j.name, j.description, v.id AS version_id, v.version, v.steps, v.recipients,
            v.escalation_settings
       FROM supplier_statement_journeys j
       JOIN LATERAL (
         SELECT * FROM supplier_statement_journey_versions
          WHERE journey_id = j.id AND workspace_owner_id = j.workspace_owner_id
          ORDER BY version DESC LIMIT 1
       ) v ON true
      WHERE j.id = $1 AND j.workspace_owner_id = $2 AND (j.supplier_id IS NULL OR j.supplier_id = $3)`,
    [journeyId, ownerId, supplierId],
  );
  if (journey.rowCount === 0) return { journeyVersionId: null, journeySnapshot: {}, recipients, needsSetup: true };
  const row = journey.rows[0];
  const steps = normalizeJourneySteps(row.steps);
  if (!recipientIds || recipientIds.length === 0) {
    const journeyRecipientIds = normalizeRecipients(row.recipients);
    if (journeyRecipientIds.length > 0) {
      recipients = await getApprovedRecipients(ownerId, supplierId, journeyRecipientIds);
    }
  }
  return {
    journeyVersionId: Number(row.version_id),
    journeySnapshot: {
      journey_id: Number(row.id),
      name: row.name,
      version: Number(row.version),
      steps,
      escalation_settings: asJson(row.escalation_settings),
    },
    recipients,
    needsSetup:
      steps.length === 0 ||
      recipients.length === 0 ||
      steps.some((step) => step.channel === "email" && !recipients.some((recipient) => Boolean(recipient.email))) ||
      steps.some((step) => step.channel === "whatsapp" && !recipients.some((recipient) => Boolean(recipient.whatsapp_phone || recipient.phone))),
  };
}

function safeCadence(value: unknown): StatementCadence {
  const cadence = String(value ?? "monthly").toLowerCase() as StatementCadence;
  if (!CADENCES.has(cadence)) throw new Error("cadence must be monthly or quarterly");
  return cadence;
}

// ── Explicit supplier contacts ───────────────────────────────────────────────

router.get("/supplier-statement-contacts", async (req, res) => {
  const wreq = workspace(req);
  if (!canRead(wreq)) return deny(res);
  const supplierId = req.query.supplier_id === undefined ? null : numberValue(req.query.supplier_id);
  if (req.query.supplier_id !== undefined && !supplierId) return res.status(400).json({ error: "supplier_id must be a positive integer" });
  const params: unknown[] = [wreq.workspaceOwnerId];
  let supplierFilter = "";
  if (supplierId) {
    if (!(await supplierExists(wreq.workspaceOwnerId, supplierId))) return res.status(404).json({ error: "Supplier not found" });
    params.push(supplierId);
    supplierFilter = ` AND c.supplier_id = $${params.length}`;
  }
  const result = await db.query(
    `SELECT c.*, s.name AS supplier_name
       FROM supplier_statement_contacts c
       JOIN suppliers s ON s.id = c.supplier_id AND s.workspace_owner_id = c.workspace_owner_id
      WHERE c.workspace_owner_id = $1 ${supplierFilter}
      ORDER BY c.is_active DESC, c.name ASC, c.id ASC`,
    params,
  );
  res.json({ contacts: result.rows });
});

router.post("/supplier-statement-contacts", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const input = body(req);
  const supplierId = numberValue(input.supplier_id);
  const name = optionalString(input.name);
  if (!supplierId || !name) return res.status(400).json({ error: "supplier_id and name are required" });
  if (!(await supplierExists(wreq.workspaceOwnerId, supplierId))) return res.status(404).json({ error: "Supplier not found" });
  const email = optionalString(input.email)?.toLowerCase() ?? null;
  const parsedPhone = normalizeSupplierContactPhone(input.phone);
  if (parsedPhone.raw && !parsedPhone.normalized) {
    return res.status(400).json({ error: "phone must be a valid international number" });
  }
  const parsedWhatsappPhone = normalizeSupplierContactPhone(input.whatsapp_phone);
  if (parsedWhatsappPhone.raw && !parsedWhatsappPhone.normalized) {
    return res.status(400).json({ error: "whatsapp_phone must be a valid international number" });
  }
  const phone = parsedPhone.normalized;
  const whatsappPhone = parsedWhatsappPhone.normalized ?? phone;
  if (!email && !whatsappPhone) return res.status(400).json({ error: "A contact email or WhatsApp-capable phone is required" });
  try {
    const result = await db.query(
      `INSERT INTO supplier_statement_contacts
        (workspace_owner_id, supplier_id, name, role, department, email, phone, whatsapp_phone,
         provenance, source_reference, is_approved, is_selected, is_active, approved_at, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,
               CASE WHEN $11 THEN now() ELSE NULL END,
               CASE WHEN $11 THEN $13 ELSE NULL END)
       RETURNING *`,
      [
        wreq.workspaceOwnerId, supplierId, name, optionalString(input.role), optionalString(input.department),
        email, phone, whatsappPhone, optionalString(input.provenance) ?? "manual",
        optionalString(input.source_reference), input.is_approved === true, input.is_selected === true, wreq.userId,
      ],
    );
    await writeAudit(wreq.workspaceOwnerId, "contact", String(result.rows[0].id), "created", wreq.userId, { supplier_id: supplierId });
    return res.status(201).json({ contact: result.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "A contact with this email already exists for this supplier" });
    throw error;
  }
});

router.patch("/supplier-statement-contacts/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const id = numberValue(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid contact id" });
  const input = body(req);
  const existing = await db.query("SELECT * FROM supplier_statement_contacts WHERE id = $1 AND workspace_owner_id = $2", [id, wreq.workspaceOwnerId]);
  if (existing.rowCount === 0) return res.status(404).json({ error: "Contact not found" });
  const existingContact = existing.rows[0] as Record<string, unknown>;
  const allowed: Record<string, string> = {
    name: "name", role: "role", department: "department", email: "email", phone: "phone",
    whatsapp_phone: "whatsapp_phone", provenance: "provenance", source_reference: "source_reference",
  };
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (key in input) {
      if (key === "phone" || key === "whatsapp_phone") {
        const parsed = normalizeSupplierContactPhone(input[key]);
        if (parsed.raw && !parsed.normalized) {
          const existingValue = optionalString(existingContact[key]);
          if (parsed.raw !== existingValue) {
            return res.status(400).json({ error: `${key} must be a valid international number` });
          }
          // Leave unchanged legacy numbers intact; they can be replaced with
          // an international number without blocking unrelated contact edits.
          values.push(existingValue);
        } else {
          values.push(parsed.normalized);
        }
      } else {
        values.push(key === "email" ? optionalString(input[key])?.toLowerCase() ?? null : optionalString(input[key]));
      }
      fields.push(`${column} = $${values.length}`);
    }
  }
  if ("is_active" in input) { values.push(input.is_active === true); fields.push(`is_active = $${values.length}`); }
  if ("is_selected" in input) { values.push(input.is_selected === true); fields.push(`is_selected = $${values.length}`); }
  if ("is_approved" in input) {
    const approved = input.is_approved === true;
    values.push(approved); fields.push(`is_approved = $${values.length}`);
    fields.push(approved ? "approved_at = now()" : "approved_at = NULL");
    values.push(approved ? wreq.userId : null); fields.push(`approved_by = $${values.length}`);
  }
  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });
  values.push(id, wreq.workspaceOwnerId);
  try {
    const result = await db.query(
      `UPDATE supplier_statement_contacts SET ${fields.join(", ")}, updated_at = now()
        WHERE id = $${values.length - 1} AND workspace_owner_id = $${values.length} RETURNING *`,
      values,
    );
    await writeAudit(wreq.workspaceOwnerId, "contact", String(id), "updated", wreq.userId, { fields: Object.keys(input) });
    return res.json({ contact: result.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "A contact with this email already exists for this supplier" });
    throw error;
  }
});

router.delete("/supplier-statement-contacts/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const id = numberValue(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid contact id" });
  const result = await db.query(
    `UPDATE supplier_statement_contacts
        SET is_active = false, is_selected = false, updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 RETURNING id`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Contact not found" });
  await writeAudit(wreq.workspaceOwnerId, "contact", String(id), "archived", wreq.userId);
  res.status(204).end();
});

// ── Versioned journeys ───────────────────────────────────────────────────────

router.get("/supplier-statement-journeys", async (req, res) => {
  const wreq = workspace(req);
  if (!canRead(wreq)) return deny(res);
  const supplierId = req.query.supplier_id === undefined ? null : numberValue(req.query.supplier_id);
  if (req.query.supplier_id !== undefined && !supplierId) return res.status(400).json({ error: "Invalid supplier_id" });
  const params: unknown[] = [wreq.workspaceOwnerId];
  const filter = supplierId ? ` AND (j.supplier_id IS NULL OR j.supplier_id = $2)` : "";
  if (supplierId) params.push(supplierId);
  const result = await db.query(
    `SELECT j.*,
            COALESCE((SELECT json_agg(v ORDER BY v.version DESC)
                        FROM supplier_statement_journey_versions v
                       WHERE v.journey_id = j.id), '[]'::json) AS versions
       FROM supplier_statement_journeys j
      WHERE j.workspace_owner_id = $1 ${filter}
      ORDER BY j.is_active DESC, j.name ASC`,
    params,
  );
  res.json({ journeys: result.rows });
});

router.post("/supplier-statement-journeys", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const input = body(req);
  const name = optionalString(input.name);
  if (!name) return res.status(400).json({ error: "name is required" });
  let steps;
  try { steps = normalizeJourneySteps(input.steps); } catch (error) { return res.status(400).json({ error: errorMessage(error) }); }
  const supplierId = input.supplier_id == null ? null : numberValue(input.supplier_id);
  if (supplierId && !(await supplierExists(wreq.workspaceOwnerId, supplierId))) return res.status(404).json({ error: "Supplier not found" });
  const recipients = normalizeRecipients(input.recipient_contact_ids ?? input.recipients);
  if (recipients.length > 0 && !supplierId) return res.status(400).json({ error: "Recipient contacts require a supplier_id" });
  if (supplierId && (await approvedRecipientCount(wreq.workspaceOwnerId, supplierId, recipients)) !== recipients.length) {
    return res.status(400).json({ error: "Journey recipients must be active, approved contacts for the supplier" });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const journey = await client.query(
      `INSERT INTO supplier_statement_journeys (workspace_owner_id, supplier_id, name, description, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [wreq.workspaceOwnerId, supplierId, name, optionalString(input.description), wreq.userId],
    );
    const version = await client.query(
      `INSERT INTO supplier_statement_journey_versions
        (journey_id, workspace_owner_id, version, steps, recipients, escalation_settings, created_by)
       VALUES ($1,$2,1,$3,$4,$5,$6) RETURNING *`,
      [journey.rows[0].id, wreq.workspaceOwnerId, jsonbParam(steps), jsonbParam(recipients), jsonbParam(input.escalation_settings), wreq.userId],
    );
    await client.query(
      `INSERT INTO supplier_statement_audit_events
         (workspace_owner_id, entity_type, entity_id, action, actor_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [wreq.workspaceOwnerId, "journey", String(journey.rows[0].id), "created", wreq.userId, jsonbParam({})],
    );
    await client.query("COMMIT");
    return res.status(201).json({ journey: journey.rows[0], version: version.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});

router.patch("/supplier-statement-journeys/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const id = numberValue(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid journey id" });
  const input = body(req);
  const existing = await db.query("SELECT * FROM supplier_statement_journeys WHERE id = $1 AND workspace_owner_id = $2", [id, wreq.workspaceOwnerId]);
  if (existing.rowCount === 0) return res.status(404).json({ error: "Journey not found" });
  const fields: string[] = [];
  const values: unknown[] = [];
  if ("name" in input && optionalString(input.name)) { values.push(optionalString(input.name)); fields.push(`name = $${values.length}`); }
  if ("description" in input) { values.push(optionalString(input.description)); fields.push(`description = $${values.length}`); }
  if ("is_active" in input) { values.push(input.is_active === true); fields.push(`is_active = $${values.length}`); }
  let steps;
  if ("steps" in input) {
    try { steps = normalizeJourneySteps(input.steps); } catch (error) { return res.status(400).json({ error: errorMessage(error) }); }
  }
  const recipients = "recipient_contact_ids" in input || "recipients" in input
    ? normalizeRecipients(input.recipient_contact_ids ?? input.recipients)
    : null;
  if (fields.length > 0) {
    values.push(id, wreq.workspaceOwnerId);
    await db.query(`UPDATE supplier_statement_journeys SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length - 1} AND workspace_owner_id = $${values.length}`, values);
  }
  if (steps || recipients) {
    const latest = await db.query("SELECT version FROM supplier_statement_journey_versions WHERE journey_id = $1 ORDER BY version DESC LIMIT 1", [id]);
    const current = await db.query("SELECT steps, recipients, escalation_settings FROM supplier_statement_journey_versions WHERE journey_id = $1 ORDER BY version DESC LIMIT 1", [id]);
    const nextVersion = Number(latest.rows[0]?.version ?? 0) + 1;
    await db.query(
      `INSERT INTO supplier_statement_journey_versions
        (journey_id, workspace_owner_id, version, steps, recipients, escalation_settings, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        wreq.workspaceOwnerId,
        nextVersion,
        jsonbParam(steps ?? current.rows[0]?.steps ?? []),
        jsonbParam(recipients ?? current.rows[0]?.recipients ?? []),
        jsonbParam(input.escalation_settings ?? current.rows[0]?.escalation_settings),
        wreq.userId,
      ],
    );
  }
  const result = await db.query("SELECT * FROM supplier_statement_journeys WHERE id = $1 AND workspace_owner_id = $2", [id, wreq.workspaceOwnerId]);
  await writeAudit(wreq.workspaceOwnerId, "journey", String(id), "updated", wreq.userId);
  res.json({ journey: result.rows[0] });
});

router.get("/supplier-statement-journeys/:id/versions", async (req, res) => {
  const wreq = workspace(req);
  if (!canRead(wreq)) return deny(res);
  const id = numberValue(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid journey id" });
  const result = await db.query(
    `SELECT * FROM supplier_statement_journey_versions WHERE journey_id = $1 AND workspace_owner_id = $2 ORDER BY version DESC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ versions: result.rows });
});

// ── Schedules ─────────────────────────────────────────────────────────────────

router.get("/supplier-statement-schedules", async (req, res) => {
  const wreq = workspace(req);
  if (!canRead(wreq)) return deny(res);
  const params: unknown[] = [wreq.workspaceOwnerId];
  const filters: string[] = [];
  if (req.query.supplier_id !== undefined) { const id = numberValue(req.query.supplier_id); if (!id) return res.status(400).json({ error: "Invalid supplier_id" }); params.push(id); filters.push(`s.supplier_id = $${params.length}`); }
  if (req.query.finance_entity_id !== undefined) { const id = numberValue(req.query.finance_entity_id); if (!id) return res.status(400).json({ error: "Invalid finance_entity_id" }); params.push(id); filters.push(`s.finance_entity_id = $${params.length}`); }
  const result = await db.query(
    `SELECT s.*, su.name AS supplier_name, fe.legal_name AS finance_entity_name,
            j.name AS journey_name,
            (SELECT count(*)::int FROM supplier_statement_contacts c
              WHERE c.workspace_owner_id = s.workspace_owner_id AND c.supplier_id = s.supplier_id
                AND c.is_active = true AND c.is_approved = true AND c.is_selected = true) AS selected_recipient_count
       FROM supplier_statement_schedules s
       JOIN suppliers su ON su.id = s.supplier_id
       JOIN finance_entities fe ON fe.id = s.finance_entity_id
       LEFT JOIN supplier_statement_journeys j ON j.id = s.journey_id
      WHERE s.workspace_owner_id = $1 ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
      ORDER BY s.is_active DESC, su.name ASC, s.id ASC`,
    params,
  );
  res.json({ schedules: result.rows });
});

router.post("/supplier-statement-schedules", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const input = body(req);
  const supplierId = numberValue(input.supplier_id);
  const entityId = numberValue(input.finance_entity_id);
  const firstRun = requireDate(input.first_run_date, "first_run_date");
  if (!supplierId || !entityId) return res.status(400).json({ error: "supplier_id and finance_entity_id are required" });
  if (!(await supplierExists(wreq.workspaceOwnerId, supplierId))) return res.status(404).json({ error: "Supplier not found" });
  if (!(await entityExists(wreq.workspaceOwnerId, entityId))) return res.status(404).json({ error: "Finance entity not found" });
  let cadence: StatementCadence;
  try { cadence = safeCadence(input.cadence); } catch (error) { return res.status(400).json({ error: errorMessage(error) }); }
  const localDay = Number(input.local_day ?? 1);
  const localTime = optionalString(input.local_time) ?? "09:00";
  const timezone = optionalString(input.timezone) ?? "UTC";
  if (!Number.isInteger(localDay) || localDay < 1 || localDay > 31) return res.status(400).json({ error: "local_day must be between 1 and 31" });
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(localTime)) return res.status(400).json({ error: "local_time must be HH:MM" });
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { return res.status(400).json({ error: "timezone is invalid" }); }
  const journeyId = input.journey_id == null ? null : numberValue(input.journey_id);
  const nextRun = calculateNextRun({ first_run_date: firstRun, cadence, local_day: localDay, local_time: localTime, timezone });
  const setup = journeyId ? await getJourneySnapshot(wreq.workspaceOwnerId, journeyId, normalizeRecipients(input.recipient_contact_ids), supplierId) : { needsSetup: true };
  const requestedActive = input.is_active === true;
  if (requestedActive && setup.needsSetup) return res.status(409).json({ error: "Schedule needs setup: select approved recipients and a journey before activation", code: "NEEDS_SETUP" });
  try {
    const result = await db.query(
      `INSERT INTO supplier_statement_schedules
        (workspace_owner_id, supplier_id, finance_entity_id, cadence, local_day, local_time, timezone,
         first_run_date, journey_id, escalation_settings, is_active, next_run_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
      [wreq.workspaceOwnerId, supplierId, entityId, cadence, localDay, localTime, timezone, firstRun, journeyId, jsonbParam(input.escalation_settings), requestedActive, nextRun, wreq.userId],
    );
    await writeAudit(wreq.workspaceOwnerId, "schedule", String(result.rows[0].id), "created", wreq.userId);
    return res.status(201).json({ schedule: { ...result.rows[0], readiness: setup.needsSetup ? "Needs setup" : "Ready" } });
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "A schedule already exists for this supplier and finance entity" });
    throw error;
  }
});

router.patch("/supplier-statement-schedules/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const id = numberValue(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid schedule id" });
  const existing = await db.query("SELECT * FROM supplier_statement_schedules WHERE id = $1 AND workspace_owner_id = $2", [id, wreq.workspaceOwnerId]);
  if (existing.rowCount === 0) return res.status(404).json({ error: "Schedule not found" });
  const current = existing.rows[0] as JsonRecord;
  const input = body(req);
  const nextSupplier = input.supplier_id === undefined ? Number(current.supplier_id) : numberValue(input.supplier_id);
  const nextEntity = input.finance_entity_id === undefined ? Number(current.finance_entity_id) : numberValue(input.finance_entity_id);
  if (!nextSupplier || !nextEntity) return res.status(400).json({ error: "Invalid supplier or finance entity" });
  if (!(await supplierExists(wreq.workspaceOwnerId, nextSupplier)) || !(await entityExists(wreq.workspaceOwnerId, nextEntity))) return res.status(404).json({ error: "Supplier or finance entity not found" });
  const cadence = input.cadence === undefined ? safeCadence(current.cadence) : safeCadence(input.cadence);
  const firstRun = input.first_run_date === undefined ? String(current.first_run_date).slice(0, 10) : requireDate(input.first_run_date, "first_run_date");
  const localDay = input.local_day === undefined ? Number(current.local_day) : Number(input.local_day);
  const localTime = input.local_time === undefined ? String(current.local_time) : String(input.local_time);
  const timezone = input.timezone === undefined ? String(current.timezone) : String(input.timezone);
  const journeyId = input.journey_id === undefined ? (current.journey_id == null ? null : Number(current.journey_id)) : (input.journey_id == null ? null : numberValue(input.journey_id));
  const nextRun = calculateNextRun({ first_run_date: firstRun, cadence, local_day: localDay, local_time: localTime, timezone });
  const setup = journeyId ? await getJourneySnapshot(wreq.workspaceOwnerId, journeyId, normalizeRecipients(input.recipient_contact_ids), nextSupplier) : { needsSetup: true };
  const requestedActive = input.is_active === undefined ? current.is_active === true : input.is_active === true;
  if (requestedActive && setup.needsSetup) return res.status(409).json({ error: "Schedule needs setup: select approved recipients and a journey before activation", code: "NEEDS_SETUP" });
  const result = await db.query(
    `UPDATE supplier_statement_schedules
        SET supplier_id=$1, finance_entity_id=$2, cadence=$3, local_day=$4, local_time=$5,
            timezone=$6, first_run_date=$7, journey_id=$8, escalation_settings=$9,
            is_active=$10, paused_at=CASE WHEN $10 THEN NULL ELSE paused_at END,
            paused_reason=CASE WHEN $10 THEN NULL ELSE paused_reason END,
            next_run_at=$11, updated_by=$12, updated_at=now()
      WHERE id=$13 AND workspace_owner_id=$14 RETURNING *`,
    [nextSupplier, nextEntity, cadence, localDay, localTime, timezone, firstRun, journeyId, jsonbParam(input.escalation_settings ?? current.escalation_settings), requestedActive, nextRun, wreq.userId, id, wreq.workspaceOwnerId],
  );
  await writeAudit(wreq.workspaceOwnerId, "schedule", String(id), requestedActive ? "resumed" : "updated", wreq.userId);
  res.json({ schedule: { ...result.rows[0], readiness: setup.needsSetup ? "Needs setup" : "Ready" } });
});

router.post("/supplier-statement-schedules/:id/pause", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const id = numberValue(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid schedule id" });
  const result = await db.query(
    `UPDATE supplier_statement_schedules SET is_active=false, paused_at=now(), paused_reason=$1, updated_by=$2, updated_at=now()
      WHERE id=$3 AND workspace_owner_id=$4 RETURNING *`,
    [optionalString(body(req).reason), wreq.userId, id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "Schedule not found" });
  await writeAudit(wreq.workspaceOwnerId, "schedule", String(id), "paused", wreq.userId);
  res.json({ schedule: result.rows[0] });
});

router.post("/supplier-statement-schedules/:id/resume", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const id = numberValue(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid schedule id" });
  const existing = await db.query("SELECT * FROM supplier_statement_schedules WHERE id = $1 AND workspace_owner_id = $2", [id, wreq.workspaceOwnerId]);
  if (existing.rowCount === 0) return res.status(404).json({ error: "Schedule not found" });
  const row = existing.rows[0];
  const setup = await getJourneySnapshot(wreq.workspaceOwnerId, row.journey_id == null ? null : Number(row.journey_id), [], Number(row.supplier_id));
  if (setup.needsSetup) return res.status(409).json({ error: "Schedule needs setup: select approved recipients and a journey before activation", code: "NEEDS_SETUP" });
  const nextRun = calculateNextRun({ first_run_date: String(row.first_run_date).slice(0, 10), cadence: row.cadence, local_day: Number(row.local_day), local_time: String(row.local_time), timezone: String(row.timezone) });
  const result = await db.query(
    `UPDATE supplier_statement_schedules SET is_active=true, paused_at=NULL, paused_reason=NULL, next_run_at=$1, updated_by=$2, updated_at=now()
      WHERE id=$3 AND workspace_owner_id=$4 RETURNING *`,
    [nextRun, wreq.userId, id, wreq.workspaceOwnerId],
  );
  await writeAudit(wreq.workspaceOwnerId, "schedule", String(id), "resumed", wreq.userId);
  res.json({ schedule: result.rows[0] });
});

// ── Period requests and timeline ─────────────────────────────────────────────

async function loadRequest(ownerId: string, id: string): Promise<JsonRecord | null> {
  const result = await db.query(
    `SELECT r.*, s.name AS supplier_name, fe.legal_name AS finance_entity_name,
            ss.id AS statement_id, ss.file_url AS statement_file_url,
            ss.received_at AS statement_received_at, ss.reconciliation_status AS statement_reconciliation_status
       FROM supplier_statement_requests r
       JOIN suppliers s ON s.id = r.supplier_id
       JOIN finance_entities fe ON fe.id = r.finance_entity_id
       LEFT JOIN supplier_statements ss ON ss.collection_request_id = r.id
      WHERE r.id = $1 AND r.workspace_owner_id = $2`,
    [id, ownerId],
  );
  return result.rows[0] ?? null;
}

router.get("/supplier-statement-requests/counts", async (req, res) => {
  const wreq = workspace(req);
  if (!canRead(wreq)) return deny(res);
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('open','in_progress','awaiting_reply','needs_setup'))::int AS open,
       COUNT(*) FILTER (WHERE status = 'needs_setup')::int AS needs_setup,
       COUNT(*) FILTER (WHERE status = 'received')::int AS received,
       COUNT(*) FILTER (WHERE status = 'reconciled')::int AS reconciled,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
       COUNT(*)::int AS total
       FROM supplier_statement_requests WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );
  res.json({ counts: result.rows[0] });
});

router.get("/supplier-statement-readiness", async (req, res) => {
  const wreq = workspace(req);
  if (!canRead(wreq)) return deny(res);
  res.json({ readiness: supplierStatementProviderReadiness() });
});

router.get("/supplier-statement-requests", async (req, res) => {
  const wreq = workspace(req);
  if (!canRead(wreq)) return deny(res);
  const params: unknown[] = [wreq.workspaceOwnerId];
  const filters: string[] = [];
  for (const [key, column] of [["supplier_id", "r.supplier_id"], ["finance_entity_id", "r.finance_entity_id"]] as const) {
    if (req.query[key] !== undefined) { const id = numberValue(req.query[key]); if (!id) return res.status(400).json({ error: `Invalid ${key}` }); params.push(id); filters.push(`${column} = $${params.length}`); }
  }
  if (req.query.status) { const statuses = String(req.query.status).split(",").filter(Boolean); params.push(statuses); filters.push(`r.status = ANY($${params.length}::text[])`); }
  if (req.query.from) { const from = parseIsoDate(req.query.from); if (!from) return res.status(400).json({ error: "Invalid from date" }); params.push(from); filters.push(`r.period_start >= $${params.length}`); }
  if (req.query.to) { const to = parseIsoDate(req.query.to); if (!to) return res.status(400).json({ error: "Invalid to date" }); params.push(to); filters.push(`r.period_end <= $${params.length}`); }
  const result = await db.query(
    `SELECT r.*, s.name AS supplier_name, fe.legal_name AS finance_entity_name,
            (SELECT count(*)::int FROM supplier_statement_communication_events e WHERE e.request_id = r.id) AS event_count
       FROM supplier_statement_requests r
       JOIN suppliers s ON s.id = r.supplier_id
       JOIN finance_entities fe ON fe.id = r.finance_entity_id
      WHERE r.workspace_owner_id = $1 ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
      ORDER BY r.period_start DESC, r.created_at DESC`,
    params,
  );
  res.json({ requests: result.rows });
});

router.post("/supplier-statement-requests", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const input = body(req);
  const supplierId = numberValue(input.supplier_id);
  const entityId = numberValue(input.finance_entity_id);
  if (!supplierId || !entityId) return res.status(400).json({ error: "supplier_id and finance_entity_id are required" });
  if (!(await supplierExists(wreq.workspaceOwnerId, supplierId))) return res.status(404).json({ error: "Supplier not found" });
  if (!(await entityExists(wreq.workspaceOwnerId, entityId))) return res.status(404).json({ error: "Finance entity not found" });
  let cadence: StatementCadence;
  try { cadence = safeCadence(input.cadence); } catch (error) { return res.status(400).json({ error: errorMessage(error) }); }
  if ((input.period_start && !input.period_end) || (!input.period_start && input.period_end)) {
    return res.status(400).json({ error: "period_start and period_end must be provided together" });
  }
  let period = input.period_start && input.period_end
    ? { periodStart: requireDate(input.period_start, "period_start"), periodEnd: requireDate(input.period_end, "period_end"), periodLabel: optionalString(input.period_label) ?? periodLabelForDates(String(input.period_start), String(input.period_end), cadence) }
    : periodForCycle(cadence);
  if (period.periodEnd < period.periodStart) return res.status(400).json({ error: "period_end must be on or after period_start" });
  const scheduleId = input.schedule_id == null ? null : numberValue(input.schedule_id);
  let journeyId = input.journey_id == null ? null : numberValue(input.journey_id);
  let requestTimezone = "UTC";
  if (scheduleId) {
    const schedule = await db.query("SELECT * FROM supplier_statement_schedules WHERE id=$1 AND workspace_owner_id=$2 AND supplier_id=$3 AND finance_entity_id=$4", [scheduleId, wreq.workspaceOwnerId, supplierId, entityId]);
    if (schedule.rowCount === 0) return res.status(404).json({ error: "Schedule not found for supplier and entity" });
    requestTimezone = optionalString(schedule.rows[0].timezone) ?? "UTC";
    if (!journeyId) journeyId = schedule.rows[0].journey_id == null ? null : Number(schedule.rows[0].journey_id);
    cadence = safeCadence(schedule.rows[0].cadence);
    if (!(input.period_start && input.period_end)) period = periodForCycle(cadence);
  }
  const recipientsRequested = normalizeRecipients(input.recipient_contact_ids ?? input.recipients);
  const snapshot = await getJourneySnapshot(wreq.workspaceOwnerId, journeyId, recipientsRequested, supplierId);
  const duplicate = await db.query(
    `SELECT * FROM supplier_statement_requests
      WHERE workspace_owner_id=$1 AND supplier_id=$2 AND finance_entity_id=$3
        AND period_start=$4 AND period_end=$5
        AND status NOT IN ('received','reconciled','cancelled')
      LIMIT 1`,
    [wreq.workspaceOwnerId, supplierId, entityId, period.periodStart, period.periodEnd],
  );
  if (duplicate.rowCount) return res.status(200).json({ request: duplicate.rows[0], reused: true });
  const needsSetup = snapshot.needsSetup;
  const initialAction = needsSetup ? "needs_setup" : "prepare";
  const requestedNextActionAt = needsSetup ? null : new Date();
  const idempotencyKey = optionalString(input.idempotency_key);
  try {
    const result = await db.query(
      `INSERT INTO supplier_statement_requests
        (workspace_owner_id, supplier_id, finance_entity_id, schedule_id, period_start, period_end,
         period_label, cadence, status, source, next_action, next_action_at, next_recurring_cycle_at,
         journey_version_id, journey_snapshot, recipients_snapshot, idempotency_key, created_by, timezone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [
        wreq.workspaceOwnerId, supplierId, entityId, scheduleId, period.periodStart, period.periodEnd, period.periodLabel,
        cadence, needsSetup ? "needs_setup" : "open", input.source === "scheduled" ? "scheduled" : "manual",
        initialAction, requestedNextActionAt, nextCycleAt(period.periodEnd),
        snapshot.journeyVersionId, jsonbParam(snapshot.journeySnapshot), jsonbParam(snapshot.recipients), idempotencyKey, wreq.userId, requestTimezone,
      ],
    );
    const request = result.rows[0];
    const steps = Array.isArray(snapshot.journeySnapshot.steps) ? normalizeJourneySteps(snapshot.journeySnapshot.steps) : [];
    for (const step of buildStepSchedule(steps, requestedNextActionAt ?? new Date())) {
      await db.query(
        `INSERT INTO supplier_statement_step_executions
          (request_id, workspace_owner_id, step_order, channel, delay_minutes, scheduled_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [request.id, wreq.workspaceOwnerId, step.order, step.channel, step.delay_minutes, step.scheduled_at],
      );
    }
    await writeAudit(wreq.workspaceOwnerId, "request", String(request.id), "created", wreq.userId, { source: request.source, period_start: period.periodStart, period_end: period.periodEnd });
    return res.status(201).json({ request });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const reused = await loadRequest(wreq.workspaceOwnerId, idempotencyKey ?? "");
      if (reused) return res.status(200).json({ request: reused, reused: true });
      return res.status(409).json({ error: "An open request already exists for this supplier, entity and period" });
    }
    throw error;
  }
});

router.patch("/supplier-statement-requests/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const input = body(req);
  const hasRecipients = Object.hasOwn(input, "recipient_contact_ids");
  const hasEmailDueAt = Object.hasOwn(input, "email_due_at");
  if (!hasRecipients && !hasEmailDueAt) return res.status(400).json({ error: "Provide recipients or email_due_at to update" });

  let emailDueAt: Date | null = null;
  if (hasEmailDueAt) {
    try { emailDueAt = requireDateTime(input.email_due_at, "email_due_at"); }
    catch (error) { return res.status(400).json({ error: errorMessage(error) }); }
  }

  let requestedIds: number[] | null = null;
  if (hasRecipients) {
    if (!Array.isArray(input.recipient_contact_ids) || input.recipient_contact_ids.length === 0) {
      return res.status(400).json({ error: "Select at least one approved recipient" });
    }
    const parsed = input.recipient_contact_ids.map(numberValue);
    if (parsed.some((id) => id === null)) return res.status(400).json({ error: "Recipient IDs must be positive integers" });
    requestedIds = [...new Set(parsed as number[])];
  }

  const client = await db.connect();
  try {
    const result = await withTransaction(client, async () => {
      const locked = await client.query(
        `SELECT * FROM supplier_statement_requests
          WHERE id=$1 AND workspace_owner_id=$2
          FOR UPDATE`,
        [req.params.id, wreq.workspaceOwnerId],
      );
      const current = locked.rows[0] as JsonRecord | undefined;
      if (!current) return { status: 404, error: "Statement request not found" };
      if (["received", "reconciled", "cancelled"].includes(String(current.status))) {
        return { status: 409, error: "Closed requests cannot be edited" };
      }

      const executionResult = await client.query(
        `SELECT id, step_order, channel, delay_minutes, scheduled_at, status
           FROM supplier_statement_step_executions
          WHERE request_id=$1 AND workspace_owner_id=$2
          ORDER BY step_order
          FOR UPDATE`,
        [req.params.id, wreq.workspaceOwnerId],
      );
      const executions = executionResult.rows as Array<JsonRecord & { id: number; step_order: number; channel: string; delay_minutes: number; status: string }>;
      if (executions.some((step) => step.status === "processing")) {
        return { status: 409, error: "A journey step is already being sent. Wait for it to finish, then edit the request." };
      }
      const pending = executions.filter((step) => step.status === "pending");
      const journeyValue = jsonRecord(current.journey_snapshot);
      let journeySteps: ReturnType<typeof normalizeJourneySteps> = [];
      try {
        if (Array.isArray(journeyValue.steps) && journeyValue.steps.length > 0) {
          journeySteps = normalizeJourneySteps(journeyValue.steps);
        }
      } catch (error) {
        return { status: 409, error: `The saved journey cannot be edited: ${errorMessage(error)}` };
      }
      if (emailDueAt && pending.length === 0) {
        return { status: 409, error: "There are no pending delivery steps to reschedule" };
      }

      let recipients: Array<Record<string, unknown>> = Array.isArray(current.recipients_snapshot)
        ? current.recipients_snapshot as Array<Record<string, unknown>>
        : [];
      const effectiveIds = requestedIds ?? normalizeRecipients(recipients.map((contact) => contact.id));
      if (requestedIds || emailDueAt) {
        if (effectiveIds.length === 0) {
          return { status: 400, error: "Select at least one active, approved recipient before editing delivery" };
        }
        const approved = await client.query(
          `SELECT id, name, role, department, email, phone, whatsapp_phone,
                  provenance, is_approved, is_selected, is_active
             FROM supplier_statement_contacts
            WHERE workspace_owner_id=$1 AND supplier_id=$2 AND id=ANY($3::int[])
              AND is_active=true AND is_approved=true
            ORDER BY name ASC, id ASC`,
          [wreq.workspaceOwnerId, Number(current.supplier_id), effectiveIds],
        );
        if (approved.rows.length !== effectiveIds.length) {
          return { status: 400, error: "Recipients must be active, approved contacts for this supplier" };
        }
        if (requestedIds) recipients = approved.rows;
        if (journeySteps.some((step) => step.channel === "email" && !recipients.some((contact) => Boolean(contact.email)))) {
          return { status: 400, error: "Select an approved recipient with an email address for this journey" };
        }
        if (journeySteps.some((step) => step.channel === "whatsapp" && !recipients.some((contact) => Boolean(contact.whatsapp_phone || contact.phone)))) {
          return { status: 400, error: "Select an approved recipient with a WhatsApp phone for this journey" };
        }
      }

      if ((hasRecipients || emailDueAt) && pending.length === 0) {
        return { status: 409, error: "There are no pending delivery steps to update" };
      }

      const changedStepOrders: number[] = [];
      if (emailDueAt) {
        const firstEmail = journeySteps.find((step) => step.channel === "email");
        if (!firstEmail) return { status: 409, error: "This request has no email step in its saved journey" };
        const emailExecution = executions.find((step) => step.step_order === firstEmail.order);
        if (!emailExecution || emailExecution.status !== "pending") {
          return { status: 409, error: "The first email is no longer pending and cannot be rescheduled" };
        }
        const planned = new Map<number, Date>([[firstEmail.order, emailDueAt]]);
        let cursor = emailDueAt.getTime();
        for (const step of journeySteps.filter((item) => item.order > firstEmail.order).sort((a, b) => a.order - b.order)) {
          cursor += step.delay_minutes * 60_000;
          planned.set(step.order, new Date(cursor));
        }
        for (const execution of pending) {
          const newTime = planned.get(execution.step_order);
          if (!newTime) continue;
          await client.query(
            `UPDATE supplier_statement_step_executions
                SET scheduled_at=$1, planned_at=$1, updated_at=now()
              WHERE id=$2 AND workspace_owner_id=$3 AND status='pending'`,
            [newTime, execution.id, wreq.workspaceOwnerId],
          );
          changedStepOrders.push(execution.step_order);
        }
      }

      const hasJourney = journeySteps.length > 0;
      const hasEmail = !journeySteps.some((step) => step.channel === "email") || recipients.some((contact) => Boolean(contact.email));
      const hasWhatsapp = !journeySteps.some((step) => step.channel === "whatsapp") || recipients.some((contact) => Boolean(contact.whatsapp_phone || contact.phone));
      const ready = hasJourney && recipients.length > 0 && hasEmail && hasWhatsapp;
      const nextPending = await client.query(
        `SELECT step_order, channel, MIN(scheduled_at) OVER () AS next_at
           FROM supplier_statement_step_executions
          WHERE request_id=$1 AND workspace_owner_id=$2 AND status='pending'
          ORDER BY step_order
          LIMIT 1`,
        [req.params.id, wreq.workspaceOwnerId],
      );
      const nextAction = ready
        ? (nextPending.rows[0]?.channel === "email" ? "send_email" : "follow_up")
        : "needs_setup";
      const nextActionAt = ready ? nextPending.rows[0]?.next_at ?? null : null;
      const updated = await client.query(
        `UPDATE supplier_statement_requests
            SET recipients_snapshot=$1::jsonb,
                status=CASE WHEN status='needs_setup' AND $2 THEN 'open' ELSE status END,
                next_action=$3, next_action_at=$4, updated_at=now()
          WHERE id=$5 AND workspace_owner_id=$6
          RETURNING *`,
        [JSON.stringify(recipients), ready, nextAction, nextActionAt, req.params.id, wreq.workspaceOwnerId],
      );
      await client.query(
        `INSERT INTO supplier_statement_audit_events
          (workspace_owner_id, entity_type, entity_id, action, actor_id, metadata)
         VALUES ($1,'request',$2,'delivery_settings_updated',$3,$4::jsonb)`,
        [
          wreq.workspaceOwnerId,
          req.params.id,
          wreq.userId,
          JSON.stringify({
            recipient_contact_ids: requestedIds,
            email_due_at: emailDueAt?.toISOString() ?? null,
            rescheduled_step_orders: changedStepOrders,
          }),
        ],
      );
      return { status: 200, request: updated.rows[0] };
    });
    return res.status(result.status).json(result.status === 200 ? { request: result.request } : { error: result.error });
  } finally {
    client.release();
  }
});

router.delete("/supplier-statement-requests/:id", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) {
    deny(res, "Supplier statement edit access required");
    return;
  }

  const id = String(req.params.id);
  const client = await db.connect();
  try {
    const result = await withTransaction(client, async () => {
      const locked = await client.query(
        `SELECT status FROM supplier_statement_requests
          WHERE id=$1 AND workspace_owner_id=$2
          FOR UPDATE`,
        [id, wreq.workspaceOwnerId],
      );
      const current = locked.rows[0] as JsonRecord | undefined;
      if (!current) return { kind: "not_found" as const, error: "Statement request not found" };
      if (!["needs_setup", "cancelled"].includes(String(current.status))) {
        return { kind: "conflict" as const, error: "Cancel active requests before deleting them." };
      }

      const executions = await client.query(
        `SELECT status FROM supplier_statement_step_executions
          WHERE request_id=$1 AND workspace_owner_id=$2
          FOR UPDATE`,
        [id, wreq.workspaceOwnerId],
      );
      const executionStatuses = executions.rows.map((row) => String(row.status));
      if (executionStatuses.includes("processing")) {
        return { kind: "conflict" as const, error: "A request step is being sent. Try deleting it again once sending finishes." };
      }
      if (executionStatuses.some((status) => !["pending", "cancelled"].includes(status))) {
        return { kind: "conflict" as const, error: "Requests with delivery history cannot be deleted." };
      }

      const activity = await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM supplier_statements
                   WHERE collection_request_id=$1 AND workspace_owner_id=$2) AS has_statement,
           EXISTS(SELECT 1 FROM supplier_statement_communication_events
                   WHERE request_id=$1 AND workspace_owner_id=$2) AS has_communication,
           EXISTS(SELECT 1 FROM supplier_statement_inbound_messages
                   WHERE request_id=$1 AND workspace_owner_id=$2) AS has_inbound`,
        [id, wreq.workspaceOwnerId],
      );
      const row = activity.rows[0] as JsonRecord | undefined;
      if (row?.has_statement) {
        return { kind: "conflict" as const, error: "Requests linked to a supplier statement cannot be deleted." };
      }
      if (row?.has_communication || row?.has_inbound) {
        return { kind: "conflict" as const, error: "Requests with communication history cannot be deleted." };
      }

      await client.query(
        `INSERT INTO supplier_statement_audit_events
          (workspace_owner_id, entity_type, entity_id, action, actor_id, metadata)
         VALUES ($1,'request',$2,'deleted',$3,$4::jsonb)`,
        [wreq.workspaceOwnerId, id, wreq.userId, JSON.stringify({ previous_status: current.status })],
      );
      const deleted = await client.query(
        `DELETE FROM supplier_statement_requests
          WHERE id=$1 AND workspace_owner_id=$2
          RETURNING id`,
        [id, wreq.workspaceOwnerId],
      );
      if (!deleted.rows[0]) return { kind: "not_found" as const, error: "Statement request not found" };
      return { kind: "deleted" as const };
    });

    if (result.kind === "deleted") {
      res.sendStatus(204);
      return;
    }
    res.status(result.kind === "not_found" ? 404 : 409).json({ error: result.error });
  } finally {
    client.release();
  }
});

router.get("/supplier-statement-requests/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canRead(wreq)) return deny(res);
  const request = await loadRequest(wreq.workspaceOwnerId, req.params.id);
  if (!request) return res.status(404).json({ error: "Statement request not found" });
  const [steps, events, inbound, audit] = await Promise.all([
    db.query("SELECT * FROM supplier_statement_step_executions WHERE request_id=$1 AND workspace_owner_id=$2 ORDER BY step_order", [req.params.id, wreq.workspaceOwnerId]),
    db.query("SELECT * FROM supplier_statement_communication_events WHERE request_id=$1 AND workspace_owner_id=$2 ORDER BY occurred_at ASC, id ASC", [req.params.id, wreq.workspaceOwnerId]),
    db.query("SELECT * FROM supplier_statement_inbound_messages WHERE request_id=$1 AND workspace_owner_id=$2 ORDER BY received_at ASC, id ASC", [req.params.id, wreq.workspaceOwnerId]),
    db.query("SELECT * FROM supplier_statement_audit_events WHERE entity_type='request' AND entity_id=$1 AND workspace_owner_id=$2 ORDER BY created_at ASC, id ASC", [req.params.id, wreq.workspaceOwnerId]),
  ]);
  res.json({
    request: {
      ...request,
      recipients_snapshot: Array.isArray(request.recipients_snapshot) ? request.recipients_snapshot : [],
    },
    steps: steps.rows,
    events: events.rows,
    inbound_messages: inbound.rows,
    audit_events: audit.rows,
  });
});

router.get("/supplier-statement-requests/:id/timeline", async (req, res) => {
  const wreq = workspace(req);
  if (!canRead(wreq)) return deny(res);
  const request = await loadRequest(wreq.workspaceOwnerId, req.params.id);
  if (!request) return res.status(404).json({ error: "Statement request not found" });
  const result = await db.query(
    `SELECT created_at AS occurred_at, 'audit' AS event_kind, action AS event_type, metadata
       FROM supplier_statement_audit_events
      WHERE entity_type='request' AND entity_id=$1 AND workspace_owner_id=$2
     UNION ALL
     SELECT occurred_at, 'communication' AS event_kind, event_type, payload AS metadata
       FROM supplier_statement_communication_events
      WHERE request_id=$1 AND workspace_owner_id=$2
     UNION ALL
     SELECT received_at, 'inbound' AS event_kind, 'inbound_message' AS event_type,
            jsonb_build_object(
              'channel', channel, 'sender', sender, 'body', body,
              'attachment_url', attachment_url, 'attachments', attachments,
              'classification', classification, 'document_status', document_status
            ) AS metadata
       FROM supplier_statement_inbound_messages
      WHERE request_id=$1 AND workspace_owner_id=$2
      ORDER BY occurred_at ASC`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  res.json({ request, timeline: result.rows });
});

async function updateRequestState(req: Parameters<Parameters<typeof router.post>[1]>[0], res: Parameters<Parameters<typeof router.post>[1]>[1], action: "pause" | "resume" | "cancel"): Promise<void> {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const id = String(req.params.id);
  const current = await loadRequest(wreq.workspaceOwnerId, id);
  if (!current) { res.status(404).json({ error: "Statement request not found" }); return; }
  if (action === "resume" && current.status === "cancelled") { res.status(409).json({ error: "Cancelled requests cannot be resumed" }); return; }
  if (action === "resume" && current.status !== "paused") { res.status(409).json({ error: "Only paused requests can be resumed" }); return; }
  if (action !== "cancel" && ["received", "reconciled", "cancelled"].includes(String(current.status))) { res.status(409).json({ error: "Closed requests cannot be paused or resumed" }); return; }
  if (action === "cancel" && ["received", "reconciled", "cancelled"].includes(String(current.status))) { res.status(409).json({ error: "Request is already closed" }); return; }
  const next = action === "pause" ? "paused" : action === "resume" ? "in_progress" : "cancelled";
  if (action === "cancel") {
    const client = await db.connect();
    try {
      const cancelled = await withTransaction(client, async () => {
        const updated = await client.query(
          `UPDATE supplier_statement_requests
              SET status='cancelled', next_action='cancelled', next_action_at=NULL,
                  cancelled_at=now(), cancelled_reason=$1, updated_at=now()
            WHERE id=$2 AND workspace_owner_id=$3
            RETURNING *`,
          [optionalString(body(req).reason), id, wreq.workspaceOwnerId],
        );
        await client.query(
          `UPDATE supplier_statement_step_executions
              SET status='cancelled', updated_at=now()
            WHERE request_id=$1 AND workspace_owner_id=$2
              AND status IN ('pending','processing')`,
          [id, wreq.workspaceOwnerId],
        );
        await client.query(
          `INSERT INTO supplier_statement_audit_events
            (workspace_owner_id, entity_type, entity_id, action, actor_id, metadata)
           VALUES ($1,'request',$2,'cancel',$3,$4::jsonb)`,
          [wreq.workspaceOwnerId, id, wreq.userId, JSON.stringify({ reason: optionalString(body(req).reason) })],
        );
        return updated.rows[0];
      });
      res.json({ request: cancelled });
      return;
    } finally {
      client.release();
    }
  }
  const result = await db.query(
    `UPDATE supplier_statement_requests
        SET status=$1, next_action=$2, next_action_at=CASE WHEN $1='cancelled' THEN NULL ELSE now() END,
            cancelled_at=CASE WHEN $1='cancelled' THEN now() ELSE cancelled_at END,
            cancelled_reason=CASE WHEN $1='cancelled' THEN $3 ELSE cancelled_reason END, updated_at=now()
      WHERE id=$4 AND workspace_owner_id=$5 RETURNING *`,
    [next, action === "pause" ? "paused" : "prepare", optionalString(body(req).reason), id, wreq.workspaceOwnerId],
  );
  await writeAudit(wreq.workspaceOwnerId, "request", id, action, wreq.userId, { reason: optionalString(body(req).reason) });
  res.json({ request: result.rows[0] });
}
router.post("/supplier-statement-requests/:id/pause", (req, res) => updateRequestState(req, res, "pause"));
router.post("/supplier-statement-requests/:id/resume", (req, res) => updateRequestState(req, res, "resume"));
router.post("/supplier-statement-requests/:id/cancel", (req, res) => updateRequestState(req, res, "cancel"));

router.post("/supplier-statement-requests/:id/receipt", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const id = String(req.params.id);
  const current = await loadRequest(wreq.workspaceOwnerId, id);
  if (!current) return res.status(404).json({ error: "Statement request not found" });
  if (["cancelled", "received", "reconciled"].includes(String(current.status))) return res.status(409).json({ error: "Request is already closed" });
  const receivedAt = optionalString(body(req).received_at) ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(receivedAt))) return res.status(400).json({ error: "received_at must be a valid date-time" });
  await markSupplierStatementReceivedById(id, wreq.workspaceOwnerId, wreq.userId, {
    source: "manual_receipt",
    received_at: receivedAt,
  });
  const result = await db.query(
    `SELECT * FROM supplier_statement_requests WHERE id=$1 AND workspace_owner_id=$2`,
    [id, wreq.workspaceOwnerId],
  );
  if (body(req).statement_id) {
    const statementId = String(body(req).statement_id);
    await db.query(
      `UPDATE supplier_statements SET collection_request_id=$1, received_at=$2, reconciliation_status='pending', updated_at=now()
        WHERE id=$3 AND workspace_owner_id=$4 AND supplier_id=$5 AND finance_entity_id=$6 AND period_start=$7 AND period_end=$8`,
      [id, receivedAt, statementId, wreq.workspaceOwnerId, current.supplier_id, current.finance_entity_id, current.period_start, current.period_end],
    );
  }
  await writeAudit(wreq.workspaceOwnerId, "request", id, "receipt_recorded", wreq.userId, { statement_id: body(req).statement_id ?? null });
  res.json({ request: result.rows[0] });
});

router.post("/supplier-statement-requests/:id/link-statement", async (req, res) => {
  const wreq = workspace(req);
  if (!canWrite(wreq)) return deny(res, "Supplier statement edit access required");
  const id = String(req.params.id);
  const request = await loadRequest(wreq.workspaceOwnerId, id);
  if (!request) return res.status(404).json({ error: "Statement request not found" });
  if (["cancelled", "received", "reconciled"].includes(String(request.status))) return res.status(409).json({ error: "Request is already closed" });
  const statementId = optionalString(body(req).statement_id);
  if (!statementId) return res.status(400).json({ error: "statement_id is required" });
  const result = await db.query(
    `UPDATE supplier_statements SET collection_request_id=$1, received_at=COALESCE(received_at, now()),
            reconciliation_status=CASE WHEN reconciliation_status='unmatched' THEN 'pending' ELSE reconciliation_status END, updated_at=now()
      WHERE id=$2 AND workspace_owner_id=$3 AND supplier_id=$4 AND finance_entity_id=$5
        AND period_start=$6 AND period_end=$7 RETURNING *`,
    [id, statementId, wreq.workspaceOwnerId, request.supplier_id, request.finance_entity_id, request.period_start, request.period_end],
  );
  if (result.rowCount === 0) return res.status(409).json({ error: "Statement does not match this supplier, entity and exact period" });
  await markSupplierStatementReceivedById(id, wreq.workspaceOwnerId, wreq.userId, { source: "manual_statement_link", statement_id: statementId });
  await writeAudit(wreq.workspaceOwnerId, "request", id, "statement_linked", wreq.userId, { statement_id: statementId });
  res.json({ statement: result.rows[0], request: await loadRequest(wreq.workspaceOwnerId, id) });
});

export default router;