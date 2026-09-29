import { Router } from "express";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, hasPageAccess, type WorkspaceRequest } from "../lib/workspace";
import { logger } from "../lib/logger";
import {
  AUDIENCE_FIELDS,
  RULE_SCHEMA_VERSION,
  validateRuleTree,
  summarizeRuleTree,
  type RuleTree,
} from "../lib/audienceRules";
import { callAI } from "../lib/ai/callAI";
import {
  evaluateMetrics,
  evaluateContacts,
  evaluateContactIds,
} from "../lib/audienceEvaluate";
import { buildTemplates, SUMMARY_RULES } from "../lib/audienceTemplates";
import { refreshAudience } from "../lib/audienceRefreshJob";

/**
 * Audiences — marketing segmentation layer above Contacts.
 *
 * All endpoints: Clerk auth + resolveWorkspace, gated by the "audiences" page
 * key ("customers" also grants access since Audiences lives beside Contacts).
 * Dynamic audiences persist a rule tree; static audiences persist explicit
 * membership rows and never change automatically.
 */
const router = Router();

router.use("/audiences", requireAuth, resolveWorkspace);

function requireAudienceAccess(wreq: WorkspaceRequest, res: import("express").Response): boolean {
  if (hasPageAccess(wreq, "audiences") || hasPageAccess(wreq, "customers")) return true;
  res.status(403).json({ error: "You do not have access to Audiences" });
  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KINDS = ["dynamic", "static"] as const;
const STATUSES = ["draft", "active", "archived"] as const;

type AudienceRow = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  status: string;
  rules: RuleTree | null;
  rules_schema_version: number;
  rules_version: number;
  cached_counts: Record<string, unknown> | null;
  last_evaluated_at: string | null;
  evaluation_status: string;
  evaluation_error: string | null;
  created_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  member_count?: number;
};

function serializeAudience(row: AudienceRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    status: row.status,
    rules: row.rules,
    rules_schema_version: row.rules_schema_version,
    rules_version: row.rules_version,
    rules_summary: row.rules ? safeSummary(row.rules) : null,
    cached_counts: row.cached_counts,
    last_evaluated_at: row.last_evaluated_at,
    evaluation_status: row.evaluation_status,
    evaluation_error: row.evaluation_error,
    member_count: row.member_count ?? null,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeSummary(rules: RuleTree): string | null {
  try {
    return summarizeRuleTree(rules);
  } catch {
    return null;
  }
}

function parsePagination(req: import("express").Request): { page: number; limit: number } {
  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "25", 10) || 25));
  return { page, limit };
}

/** Validate rules payload; on failure respond 400 and return null. */
function requireValidRules(body: unknown, res: import("express").Response): RuleTree | null {
  const errors = validateRuleTree(body);
  if (errors.length > 0) {
    res.status(400).json({ error: "Invalid rules", rule_errors: errors });
    return null;
  }
  return body as RuleTree;
}

// ── Registry / templates / summary (static paths before /:id) ───────────

/** GET /api/audiences/fields — field/operator registry for the builder UI. */
router.get("/audiences/fields", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  res.json({ schema_version: RULE_SCHEMA_VERSION, fields: AUDIENCE_FIELDS });
});

/**
 * GET /api/audiences/summary — index-level metric cards. Every number comes
 * from the shared evaluation service so it can never drift from previews.
 */
router.get("/audiences/summary", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const entries = await Promise.all(
    Object.entries(SUMMARY_RULES).map(async ([key, tree]) => {
      const m = await evaluateMetrics(wreq.workspaceOwnerId, { kind: "rules", tree });
      return [key, m.matched] as const;
    }),
  );
  res.json({
    marketable_contacts: entries.find(([k]) => k === "marketable_contacts")?.[1] ?? 0,
    email_reachable: entries.find(([k]) => k === "email_reachable")?.[1] ?? 0,
    whatsapp_reachable: entries.find(([k]) => k === "whatsapp_reachable")?.[1] ?? 0,
    recipients_not_converted: entries.find(([k]) => k === "recipients_not_converted")?.[1] ?? 0,
  });
});

/**
 * GET /api/audiences/templates — the three system opportunity templates with
 * live counts. ?lapsed_days=N customizes the lapsed-senders window. Nothing
 * is persisted here.
 */
router.get("/audiences/templates", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const lapsedDays = Math.max(1, parseInt((req.query.lapsed_days as string) || "180", 10) || 180);
  const templates = buildTemplates(lapsedDays);
  const withCounts = await Promise.all(
    templates.map(async (t) => {
      const m = await evaluateMetrics(wreq.workspaceOwnerId, { kind: "rules", tree: t.rules });
      return {
        key: t.key,
        name: t.name,
        description: t.description,
        editable_params: t.editableParams,
        rules: t.rules,
        rules_summary: safeSummary(t.rules),
        metrics: m,
      };
    }),
  );
  res.json({ templates: withCounts });
});

/**
 * POST /api/audiences/generate — AI-powered rule tree generation.
 * Accepts a plain-language prompt and returns a valid RuleTree.
 * Retries once with validation errors appended before returning 422.
 */
router.post("/audiences/generate", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;

  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  const fieldRegistry = AUDIENCE_FIELDS.map((f) => {
    const parts = [
      `key: ${f.key}`,
      `label: "${f.label}"`,
      `group: ${f.group}`,
      `type: ${f.type}`,
      `operators: [${f.operators.join(", ")}]`,
    ];
    if (f.enumValues) parts.push(`enumValues: [${f.enumValues.join(", ")}]`);
    if (f.description) parts.push(`description: "${f.description}"`);
    return `- ${parts.join(", ")}`;
  }).join("\n");

  const systemPrompt = `You are an audience rule tree generator for a gift/flower e-commerce platform. Convert plain-language audience descriptions into valid rule tree JSON.

Available fields:
${fieldRegistry}

Output schema (JSON only, no extra text):
{
  "schemaVersion": 1,
  "include": {
    "logic": "ALL" | "ANY",
    "conditions": [{ "field": "<key>", "operator": "<op>", "value": <value> }],
    "groups": []
  }
}

Rules:
- schemaVersion must be 1
- Use only field keys and operators listed above
- Omit "value" for operators: is_true, is_false, is_set, is_missing
- within_last_days / more_than_days_ago / within_next_days: value is a non-negative integer (number of days)
- between: value is [min, max] array (numbers or ISO dates depending on field type)
- in / not_in: value is a non-empty string array
- Return ONLY valid JSON`;

  async function attempt(extraContext?: string): Promise<{ tree: RuleTree | null; errors: string[] }> {
    const userContent = extraContext
      ? `${prompt}\n\nPrevious attempt failed validation:\n${extraContext}\nPlease fix the issues and return corrected JSON.`
      : prompt;
    try {
      const completion = await callAI({
        actionKey: "audiences.rule_generation",
        surface: "audiences",
        provider: "openai",
        model: "gpt-4o-mini",
        sessionId: `workspace:${wreq.workspaceOwnerId}`,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      });
      const content = completion.choices[0]?.message?.content ?? "";
      const parsed: unknown = JSON.parse(content);
      const errors = validateRuleTree(parsed);
      if (errors.length === 0) return { tree: parsed as RuleTree, errors: [] };
      return { tree: null, errors: errors.map((e) => `${e.path}: ${e.message}`) };
    } catch (e) {
      return { tree: null, errors: [e instanceof Error ? e.message : "AI generation failed"] };
    }
  }

  const first = await attempt();
  if (first.tree) {
    res.json({ rules: first.tree });
    return;
  }

  logger.warn({ errors: first.errors }, "Audience generate: first attempt invalid; retrying");
  const second = await attempt(first.errors.join("\n"));
  if (second.tree) {
    res.json({ rules: second.tree });
    return;
  }

  res.status(422).json({ error: "AI could not generate a valid rule tree", details: second.errors });
});

/** POST /api/audiences/validate — validate a rule tree; per-node errors. */
router.post("/audiences/validate", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const errors = validateRuleTree(req.body?.rules);
  res.json({
    valid: errors.length === 0,
    rule_errors: errors,
    summary: errors.length === 0 ? safeSummary(req.body.rules as RuleTree) : null,
  });
});

/** POST /api/audiences/preview — evaluate a rule tree without saving. */
router.post("/audiences/preview", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const tree = requireValidRules(req.body?.rules, res);
  if (!tree) return;
  const metrics = await evaluateMetrics(wreq.workspaceOwnerId, { kind: "rules", tree });
  res.json({ metrics, summary: safeSummary(tree) });
});

/**
 * POST /api/audiences/preview/contacts — paginated sample of matching
 * contacts with "why included" evidence and near-miss exclusions.
 */
router.post("/audiences/preview/contacts", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const tree = requireValidRules(req.body?.rules, res);
  if (!tree) return;
  const page = Math.max(1, parseInt(String(req.body?.page ?? "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.body?.limit ?? "25"), 10) || 25));
  const result = await evaluateContacts(wreq.workspaceOwnerId, { kind: "rules", tree }, page, limit);
  res.json({ contacts: result.contacts, total: result.total, page, limit });
});

// ── CRUD ────────────────────────────────────────────────────────────────

/** GET /api/audiences — list with filters + pagination. */
router.get("/audiences", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const { page, limit } = parsePagination(req);
  const offset = (page - 1) * limit;
  const status = ((req.query.status as string) || "").trim().toLowerCase();
  const kind = ((req.query.kind as string) || "").trim().toLowerCase();
  const search = ((req.query.search as string) || "").trim();

  const conds: string[] = ["a.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];
  let idx = 2;
  if (status && (STATUSES as readonly string[]).includes(status)) {
    conds.push(`a.status = $${idx++}`);
    params.push(status);
  } else if (!status) {
    conds.push(`a.status <> 'archived'`);
  }
  if (kind && (KINDS as readonly string[]).includes(kind)) {
    conds.push(`a.kind = $${idx++}`);
    params.push(kind);
  }
  if (search) {
    conds.push(`a.name ILIKE $${idx++}`);
    params.push(`%${search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
  }
  const where = conds.join(" AND ");
  const [rows, count] = await Promise.all([
    db.query<AudienceRow>(
      `SELECT a.*, (SELECT COUNT(*) FROM audience_members am WHERE am.audience_id = a.id)::int AS member_count
         FROM audiences a
        WHERE ${where}
        ORDER BY a.updated_at DESC, a.id
        LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
    db.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM audiences a WHERE ${where}`, params),
  ]);
  res.json({
    audiences: rows.rows.map(serializeAudience),
    total: count.rows[0]?.total ?? 0,
    page,
    limit,
  });
});

/** POST /api/audiences — create (draft by default). */
router.post("/audiences", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const kind = String(req.body?.kind ?? "dynamic");
  if (!(KINDS as readonly string[]).includes(kind)) {
    res.status(400).json({ error: `kind must be one of ${KINDS.join(", ")}` });
    return;
  }
  const status = String(req.body?.status ?? "draft");
  if (!["draft", "active"].includes(status)) {
    res.status(400).json({ error: "status must be draft or active on create" });
    return;
  }
  let rules: RuleTree | null = null;
  if (kind === "dynamic") {
    rules = requireValidRules(req.body?.rules, res);
    if (!rules) return;
  }
  const description = req.body?.description != null ? String(req.body.description) : null;

  const client = await db.connect();
  let created: AudienceRow;
  try {
    created = await withTransaction(client, async () => {
      const r = await client.query<AudienceRow>(
        `INSERT INTO audiences
           (workspace_owner_id, name, description, kind, status, rules, rules_schema_version, rules_version, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          wreq.workspaceOwnerId,
          name,
          description,
          kind,
          status,
          rules ? JSON.stringify(rules) : null,
          RULE_SCHEMA_VERSION,
          rules ? 1 : 0,
          wreq.userId ?? null,
        ],
      );
      const row = r.rows[0];
      if (rules) {
        await client.query(
          `INSERT INTO audience_rule_versions (audience_id, version, rules, rules_schema_version, created_by)
           VALUES ($1, 1, $2, $3, $4)`,
          [row.id, JSON.stringify(rules), RULE_SCHEMA_VERSION, wreq.userId ?? null],
        );
      }
      return row;
    });
  } finally {
    client.release();
  }

  res.status(201).json({ audience: serializeAudience(created) });
});

async function loadAudience(
  wreq: WorkspaceRequest,
  id: string,
): Promise<AudienceRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await db.query<AudienceRow>(
    `SELECT a.*, (SELECT COUNT(*) FROM audience_members am WHERE am.audience_id = a.id)::int AS member_count
       FROM audiences a WHERE a.id = $1 AND a.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  return r.rows[0] ?? null;
}

/** GET /api/audiences/:id */
router.get("/audiences/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const row = await loadAudience(wreq, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }
  res.json({ audience: serializeAudience(row) });
});

/**
 * PATCH /api/audiences/:id — update name/description/rules/status.
 * Status transitions: draft|active|archived (archive also stamps archived_at).
 * A rules change bumps rules_version and appends a rule-version row.
 */
router.patch("/audiences/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const row = await loadAudience(wreq, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  let newRules: RuleTree | null = null;

  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }
    sets.push(`name = $${idx++}`);
    params.push(name);
  }
  if (req.body?.description !== undefined) {
    sets.push(`description = $${idx++}`);
    params.push(req.body.description != null ? String(req.body.description) : null);
  }
  if (req.body?.status !== undefined) {
    const status = String(req.body.status);
    if (!(STATUSES as readonly string[]).includes(status)) {
      res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
      return;
    }
    sets.push(`status = $${idx++}`);
    params.push(status);
    sets.push(status === "archived" ? `archived_at = now()` : `archived_at = NULL`);
  }
  if (req.body?.rules !== undefined) {
    if (row.kind !== "dynamic") {
      res.status(400).json({ error: "static audiences have no rules" });
      return;
    }
    newRules = requireValidRules(req.body.rules, res);
    if (!newRules) return;
    sets.push(`rules = $${idx++}`);
    params.push(JSON.stringify(newRules));
    sets.push(`rules_schema_version = $${idx++}`);
    params.push(RULE_SCHEMA_VERSION);
    sets.push(`rules_version = rules_version + 1`);
  }
  if (sets.length === 0) {
    res.status(400).json({ error: "no fields to update" });
    return;
  }
  sets.push(`updated_at = now()`);

  const client = await db.connect();
  let updated: AudienceRow;
  try {
    updated = await withTransaction(client, async () => {
      const r = await client.query<AudienceRow>(
        `UPDATE audiences SET ${sets.join(", ")}
          WHERE id = $${idx} AND workspace_owner_id = $${idx + 1}
          RETURNING *`,
        [...params, row.id, wreq.workspaceOwnerId],
      );
      const u = r.rows[0];
      if (newRules) {
        await client.query(
          `INSERT INTO audience_rule_versions (audience_id, version, rules, rules_schema_version, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [u.id, u.rules_version, JSON.stringify(newRules), RULE_SCHEMA_VERSION, wreq.userId ?? null],
        );
      }
      return u;
    });
  } finally {
    client.release();
  }

  res.json({ audience: serializeAudience(updated) });
});

/** POST /api/audiences/:id/archive */
router.post("/audiences/:id/archive", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const r = await db.query<AudienceRow>(
    `UPDATE audiences SET status = 'archived', archived_at = now(), updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 RETURNING *`,
    [UUID_RE.test(String(req.params.id)) ? req.params.id : "00000000-0000-0000-0000-000000000000", wreq.workspaceOwnerId],
  );
  if (!r.rows[0]) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }
  res.json({ audience: serializeAudience(r.rows[0]) });
});

/** POST /api/audiences/:id/duplicate — copy rules (and static members). */
router.post("/audiences/:id/duplicate", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const row = await loadAudience(wreq, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }
  const client = await db.connect();
  let copy: AudienceRow;
  try {
    copy = await withTransaction(client, async () => {
      const r = await client.query<AudienceRow>(
        `INSERT INTO audiences
           (workspace_owner_id, name, description, kind, status, rules, rules_schema_version, rules_version, created_by)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8)
         RETURNING *`,
        [
          wreq.workspaceOwnerId,
          `${row.name} (copy)`,
          row.description,
          row.kind,
          row.rules ? JSON.stringify(row.rules) : null,
          row.rules_schema_version,
          row.rules ? 1 : 0,
          wreq.userId ?? null,
        ],
      );
      const dup = r.rows[0];
      if (row.rules) {
        await client.query(
          `INSERT INTO audience_rule_versions (audience_id, version, rules, rules_schema_version, created_by)
           VALUES ($1, 1, $2, $3, $4)`,
          [dup.id, JSON.stringify(row.rules), row.rules_schema_version, wreq.userId ?? null],
        );
      }
      if (row.kind === "static") {
        await client.query(
          `INSERT INTO audience_members (audience_id, contact_id, source, added_by)
           SELECT $1, contact_id, source, $3 FROM audience_members WHERE audience_id = $2
           ON CONFLICT DO NOTHING`,
          [dup.id, row.id, wreq.userId ?? null],
        );
      }
      return dup;
    });
  } finally {
    client.release();
  }
  res.status(201).json({ audience: serializeAudience(copy) });
});

/** POST /api/audiences/:id/refresh — re-evaluate now and persist counts. */
router.post("/audiences/:id/refresh", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const row = await loadAudience(wreq, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }
  const refreshed = await refreshAudience(wreq.workspaceOwnerId, row.id);
  const after = await loadAudience(wreq, row.id);
  res.json({ audience: after ? serializeAudience(after) : null, ok: refreshed });
});

/**
 * GET /api/audiences/:id/contacts — paginated members. Dynamic audiences are
 * evaluated live through the shared evaluator (with evidence); static
 * audiences read audience_members.
 */
router.get("/audiences/:id/contacts", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const row = await loadAudience(wreq, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }
  const { page, limit } = parsePagination(req);
  const source =
    row.kind === "static"
      ? ({ kind: "static", audienceId: row.id } as const)
      : ({ kind: "rules", tree: row.rules as RuleTree } as const);
  if (row.kind === "dynamic" && !row.rules) {
    res.json({ contacts: [], total: 0, page, limit });
    return;
  }
  const result = await evaluateContacts(wreq.workspaceOwnerId, source, page, limit);
  res.json({ contacts: result.contacts, total: result.total, page, limit });
});

// ── Static membership management ────────────────────────────────────────

/** POST /api/audiences/:id/members — add contact ids (static only). */
router.post("/audiences/:id/members", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const row = await loadAudience(wreq, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }
  if (row.kind !== "static") {
    res.status(400).json({ error: "members can only be managed on static audiences" });
    return;
  }
  const contactIds: unknown = req.body?.contact_ids;
  if (!Array.isArray(contactIds) || contactIds.length === 0 || !contactIds.every((v) => typeof v === "string" && UUID_RE.test(v))) {
    res.status(400).json({ error: "contact_ids must be a non-empty array of contact UUIDs" });
    return;
  }
  const r = await db.query<{ inserted: number }>(
    `WITH ins AS (
       INSERT INTO audience_members (audience_id, contact_id, source, added_by)
       SELECT $1, c.id, 'manual', $4
         FROM contacts c
        WHERE c.id = ANY($2::uuid[]) AND c.workspace_owner_id = $3 AND c.archived_at IS NULL
       ON CONFLICT (audience_id, contact_id) DO NOTHING
       RETURNING 1
     ) SELECT COUNT(*)::int AS inserted FROM ins`,
    [row.id, contactIds, wreq.workspaceOwnerId, wreq.userId ?? null],
  );
  res.json({ added: r.rows[0]?.inserted ?? 0 });
});

/** DELETE /api/audiences/:id/members — remove contact ids (static only). */
router.delete("/audiences/:id/members", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const row = await loadAudience(wreq, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }
  if (row.kind !== "static") {
    res.status(400).json({ error: "members can only be managed on static audiences" });
    return;
  }
  const contactIds: unknown = req.body?.contact_ids;
  if (!Array.isArray(contactIds) || contactIds.length === 0 || !contactIds.every((v) => typeof v === "string" && UUID_RE.test(v))) {
    res.status(400).json({ error: "contact_ids must be a non-empty array of contact UUIDs" });
    return;
  }
  const r = await db.query(
    `DELETE FROM audience_members WHERE audience_id = $1 AND contact_id = ANY($2::uuid[])`,
    [row.id, contactIds],
  );
  res.json({ removed: r.rowCount ?? 0 });
});

/**
 * POST /api/audiences/:id/snapshot — fill a static audience from a rule tree
 * (e.g. a dynamic audience's rules). Membership never changes afterwards.
 */
router.post("/audiences/:id/snapshot", async (req, res) => {
  const wreq = workspace(req);
  if (!requireAudienceAccess(wreq, res)) return;
  const row = await loadAudience(wreq, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }
  if (row.kind !== "static") {
    res.status(400).json({ error: "snapshot targets must be static audiences" });
    return;
  }

  let tree: RuleTree | null = null;
  const fromAudienceId = req.body?.from_audience_id as string | undefined;
  if (fromAudienceId) {
    const src = await loadAudience(wreq, String(fromAudienceId));
    if (!src || src.kind !== "dynamic" || !src.rules) {
      res.status(400).json({ error: "from_audience_id must reference a dynamic audience with rules" });
      return;
    }
    tree = src.rules;
  } else {
    tree = requireValidRules(req.body?.rules, res);
    if (!tree) return;
  }

  const ids = await evaluateContactIds(wreq.workspaceOwnerId, tree);
  let added = 0;
  if (ids.length > 0) {
    const r = await db.query<{ inserted: number }>(
      `WITH ins AS (
         INSERT INTO audience_members (audience_id, contact_id, source, added_by)
         SELECT $1, x, 'snapshot', $3 FROM unnest($2::uuid[]) x
         ON CONFLICT (audience_id, contact_id) DO NOTHING
         RETURNING 1
       ) SELECT COUNT(*)::int AS inserted FROM ins`,
      [row.id, ids, wreq.userId ?? null],
    );
    added = r.rows[0]?.inserted ?? 0;
  }
  logger.info(
    { audienceId: row.id, matched: ids.length, added },
    "audiences: snapshot membership written",
  );
  res.json({ added, matched: ids.length });
});

export default router;
