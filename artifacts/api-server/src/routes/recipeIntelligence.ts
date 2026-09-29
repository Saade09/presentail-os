import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, authed } from "../lib/auth";
import { db } from "../lib/db";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  analyzeRecipeWorkspace,
  ensureDeterministicRecipeRules,
  type RecipeRuleCandidate,
} from "../lib/recipeIntelligence";

const router = Router();
router.use(requireAuth, resolveWorkspace);

function canManageRecipeIntelligence(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceRole === "owner"
    || (wreq.allowedPages?.includes("products.manage") ?? false);
}

function rejectUnauthorized(
  wreq: ReturnType<typeof workspace>,
  res: Response,
): boolean {
  if (canManageRecipeIntelligence(wreq)) return false;
  res.status(403).json({
    error: "Recipe intelligence requires owner access or the manage products permission",
  });
  return true;
}

type RuleRow = {
  id: number;
  workspace_owner_id: string;
  rule_key: string;
  name: string;
  description: string | null;
  rule_type: string;
  source: string;
  status: "candidate" | "approved" | "rejected" | "inactive";
  definition: Record<string, unknown>;
  confidence: string | null;
  created_by_user_id: string | null;
  decided_by_user_id: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

function validateStoredRuleScope(definition: Record<string, unknown>): string | null {
  const scope = definition.proposed_scope;
  const nonEmpty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  if (scope === "exact_phrase" && !nonEmpty(definition.phrase)) {
    return "Exact-phrase rules require a phrase condition";
  }
  if (scope === "ingredient_color_combination" && (
    !nonEmpty(definition.ingredient) || !nonEmpty(definition.color)
  )) {
    return "Ingredient/color rules require both ingredient and color conditions";
  }
  if (scope === "canonical_product_format" && !nonEmpty(definition.canonical_product_format)) {
    return "Canonical-format rules require a canonical Product-format condition";
  }
  if (scope === "dimension_pattern" && (
    !definition.dimensions || typeof definition.dimensions !== "object"
    || Array.isArray(definition.dimensions)
    || Object.keys(definition.dimensions as Record<string, unknown>).length === 0
  )) {
    return "Dimension-pattern rules require explicit named dimension conditions";
  }
  if (scope === "workspace_wide_rule" && definition.workspace_wide !== true) {
    return "Workspace-wide rules must be explicitly marked workspace_wide";
  }
  return null;
}

router.get("/recipe-intelligence/audit", async (req, res) => {
  const wreq = workspace(req);
  if (rejectUnauthorized(wreq, res)) return;

  const audit = await analyzeRecipeWorkspace(wreq.workspaceOwnerId);
  res.json({ audit });
});

router.get("/recipe-intelligence/review-queue", async (req, res) => {
  const wreq = workspace(req);
  if (rejectUnauthorized(wreq, res)) return;
  const [attention, corrections, candidates] = await Promise.all([
    db.query(
      `SELECT line.id AS line_id, line.suggestion_id, suggestion.product_id,
              product.name AS product_name, line.extracted_requirement,
              line.match_confidence, line.resolution_status, line.rationale,
              line.source_evidence
         FROM recipe_suggestion_lines line
         JOIN recipe_suggestions suggestion
           ON suggestion.id = line.suggestion_id
          AND suggestion.workspace_owner_id = line.workspace_owner_id
         LEFT JOIN products product
           ON product.id = suggestion.product_id
          AND product.workspace_owner_id = suggestion.workspace_owner_id
        WHERE line.workspace_owner_id = $1
          AND suggestion.status IN ('draft', 'generated', 'under_review')
          AND (
            line.resolution_status = 'unresolved'
            OR line.match_confidence IN ('low', 'no_match')
          )
        ORDER BY CASE line.resolution_status WHEN 'unresolved' THEN 0 ELSE 1 END,
                 suggestion.created_at DESC, line.line_order ASC`,
      [wreq.workspaceOwnerId],
    ),
    db.query(
      `SELECT correction.id, correction.suggestion_id, correction.line_id,
              correction.correction_type, correction.extraction_error_type,
              correction.reason, correction.note, correction.intent,
              correction.proposed_scope, correction.original_line,
              correction.corrected_line, correction.created_at,
              suggestion.product_id, product.name AS product_name
         FROM recipe_suggestion_corrections correction
         JOIN recipe_suggestions suggestion
           ON suggestion.id = correction.suggestion_id
          AND suggestion.workspace_owner_id = correction.workspace_owner_id
         LEFT JOIN products product
           ON product.id = suggestion.product_id
          AND product.workspace_owner_id = suggestion.workspace_owner_id
        WHERE correction.workspace_owner_id = $1
        ORDER BY correction.created_at DESC, correction.id DESC
        LIMIT 250`,
      [wreq.workspaceOwnerId],
    ),
    db.query(
      `SELECT 'rule'::text AS candidate_kind, rule.id, rule.status,
              rule.name AS label, rule.definition AS proposed_value,
              rule.created_at,
              COUNT(evidence.id) FILTER (WHERE evidence.evidence_type = 'supporting')::integer AS supporting_count,
              COUNT(evidence.id) FILTER (WHERE evidence.evidence_type = 'conflicting')::integer AS conflict_count,
              COALESCE(jsonb_agg(DISTINCT evidence.product_name_snapshot)
                FILTER (WHERE evidence.product_name_snapshot IS NOT NULL), '[]'::jsonb) AS supporting_products
         FROM recipe_rules rule
         LEFT JOIN recipe_rule_evidence evidence
           ON evidence.rule_id = rule.id
          AND evidence.workspace_owner_id = rule.workspace_owner_id
        WHERE rule.workspace_owner_id = $1
        GROUP BY rule.id
       UNION ALL
       SELECT 'alias', alias.id, alias.status, alias.alias,
              jsonb_build_object('base_item_id', alias.base_item_id),
              alias.created_at,
               COUNT(DISTINCT correction.id)::integer, 0,
               COALESCE(jsonb_agg(DISTINCT product.name)
                 FILTER (WHERE product.name IS NOT NULL), '[]'::jsonb)
         FROM base_item_aliases alias
         LEFT JOIN recipe_suggestion_corrections correction
           ON correction.candidate_alias_id = alias.id
          AND correction.workspace_owner_id = alias.workspace_owner_id
          LEFT JOIN recipe_suggestions suggestion
            ON suggestion.id = correction.suggestion_id
           AND suggestion.workspace_owner_id = correction.workspace_owner_id
          LEFT JOIN products product
            ON product.id = suggestion.product_id
           AND product.workspace_owner_id = suggestion.workspace_owner_id
        WHERE alias.workspace_owner_id = $1
        GROUP BY alias.id
       UNION ALL
       SELECT 'metadata', metadata.id, metadata.status,
              metadata.attribute_type,
              metadata.proposed_value,
              metadata.created_at,
               COUNT(DISTINCT correction.id)::integer, 0,
               COALESCE(jsonb_agg(DISTINCT product.name)
                 FILTER (WHERE product.name IS NOT NULL), '[]'::jsonb)
         FROM base_item_metadata_candidates metadata
         LEFT JOIN recipe_suggestion_corrections correction
           ON correction.candidate_metadata_id = metadata.id
          AND correction.workspace_owner_id = metadata.workspace_owner_id
          LEFT JOIN recipe_suggestions suggestion
            ON suggestion.id = correction.suggestion_id
           AND suggestion.workspace_owner_id = correction.workspace_owner_id
          LEFT JOIN products product
            ON product.id = suggestion.product_id
           AND product.workspace_owner_id = suggestion.workspace_owner_id
        WHERE metadata.workspace_owner_id = $1
        GROUP BY metadata.id
       ORDER BY created_at DESC`,
      [wreq.workspaceOwnerId],
    ),
  ]);
  res.json({
    attention_lines: attention.rows,
    submitted_corrections: corrections.rows,
    learning_candidates: candidates.rows,
  });
});

router.get("/recipe-intelligence/rules", async (req, res) => {
  const wreq = workspace(req);
  if (rejectUnauthorized(wreq, res)) return;
  await ensureDeterministicRecipeRules(wreq.workspaceOwnerId);

  const result = await db.query<RuleRow>(
    `SELECT id, workspace_owner_id, rule_key, name, description, rule_type,
            source, status, definition, confidence, created_by_user_id,
            decided_by_user_id, decided_at, created_at, updated_at
       FROM recipe_rules
      WHERE workspace_owner_id = $1
      ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
               created_at DESC, id DESC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ rules: result.rows });
});

router.get("/recipe-intelligence/rules/:id", async (req, res) => {
  const wreq = workspace(req);
  if (rejectUnauthorized(wreq, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid recipe rule id" });
    return;
  }

  const ruleResult = await db.query<RuleRow>(
    `SELECT id, workspace_owner_id, rule_key, name, description, rule_type,
            source, status, definition, confidence, created_by_user_id,
            decided_by_user_id, decided_at, created_at, updated_at
       FROM recipe_rules
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  const rule = ruleResult.rows[0];
  if (!rule) {
    res.status(404).json({ error: "Recipe rule not found" });
    return;
  }

  const [evidence, actions] = await Promise.all([
    db.query(
      `SELECT id, evidence_type, product_id, base_item_id, product_name_snapshot,
              base_item_name_snapshot, details, created_at
         FROM recipe_rule_evidence
        WHERE rule_id = $1 AND workspace_owner_id = $2
        ORDER BY created_at DESC, id DESC`,
      [id, wreq.workspaceOwnerId],
    ),
    db.query(
      `SELECT id, action, actor_user_id, previous_state, next_state, note, created_at
         FROM recipe_rule_actions
        WHERE rule_id = $1 AND workspace_owner_id = $2
        ORDER BY created_at DESC, id DESC`,
      [id, wreq.workspaceOwnerId],
    ),
  ]);
  res.json({ rule, evidence: evidence.rows, actions: actions.rows });
});

const decisionSchema = z.object({
  action: z.enum(["approve", "reject", "edit", "deactivate", "rollback"]),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  note: z.string().trim().max(2_000).nullable().optional(),
}).superRefine((value, context) => {
  if (
    value.action === "edit"
    && value.name === undefined
    && value.description === undefined
    && value.definition === undefined
    && value.confidence === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "An edit must change at least one rule field",
    });
  }
});

const metadataDecisionSchema = z.object({
  action: z.enum(["approve", "reject", "deactivate", "edit"]),
  note: z.string().trim().max(2_000).nullable().optional(),
  proposed_value: z.unknown().optional(),
  source_text: z.string().trim().max(1_000).nullable().optional(),
}).superRefine((value, context) => {
  if (value.action === "edit" && value.proposed_value === undefined && value.source_text === undefined) {
    context.addIssue({ code: "custom", message: "An edit must change proposed_value or source_text" });
  }
});

const aliasDecisionSchema = z.object({
  action: z.enum(["approve", "reject", "deactivate", "edit"]),
  note: z.string().trim().max(2_000).nullable().optional(),
  alias: z.string().trim().min(1).max(250).optional(),
}).superRefine((value, context) => {
  if (value.action === "edit" && value.alias === undefined) {
    context.addIssue({ code: "custom", message: "An edit must provide an alias" });
  }
});

router.get("/recipe-intelligence/base-item-metadata-candidates", async (req, res) => {
  const wreq = workspace(req);
  if (rejectUnauthorized(wreq, res)) return;
  const result = await db.query(
    `SELECT candidate.id, candidate.base_item_id, bi.name AS base_item_name,
            candidate.attribute_type, candidate.proposed_value, candidate.source_text,
            candidate.extraction_method, candidate.confidence, candidate.source_type,
            candidate.source_actor_user_id, candidate.status, candidate.decided_by_user_id,
            candidate.decided_at, candidate.decision_note, candidate.created_at, candidate.updated_at
       FROM base_item_metadata_candidates candidate
       JOIN base_items bi
         ON bi.id = candidate.base_item_id
        AND bi.workspace_owner_id = candidate.workspace_owner_id
      WHERE candidate.workspace_owner_id = $1
      ORDER BY CASE candidate.status WHEN 'candidate' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
               candidate.created_at DESC, candidate.id DESC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ candidates: result.rows });
});

router.post("/recipe-intelligence/base-item-metadata-candidates/:id/decision", async (req, res) => {
  const wreq = workspace(req);
  if (rejectUnauthorized(wreq, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid Base Item metadata candidate id" });
    return;
  }
  const parsed = metadataDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid metadata decision", details: parsed.error.issues });
    return;
  }
  const isEdit = parsed.data.action === "edit";
  const status = parsed.data.action === "approve"
    ? "approved"
    : parsed.data.action === "reject" ? "rejected" : parsed.data.action === "deactivate" ? "deactivated" : "candidate";
  const result = await db.query(
    `WITH previous AS (
       SELECT * FROM base_item_metadata_candidates
        WHERE id = $1 AND workspace_owner_id = $2
        FOR UPDATE
     ), updated AS (
       UPDATE base_item_metadata_candidates candidate
          SET status = $3,
               proposed_value = CASE WHEN $7 THEN $8::jsonb ELSE candidate.proposed_value END,
               source_text = CASE WHEN $9 THEN $10 ELSE candidate.source_text END,
               decided_by_user_id = CASE WHEN $7 THEN candidate.decided_by_user_id ELSE $4 END,
               decided_at = CASE WHEN $7 THEN candidate.decided_at ELSE now() END,
               decision_note = CASE WHEN $7 THEN candidate.decision_note ELSE $5 END,
              updated_at = now()
         FROM previous
        WHERE candidate.id = previous.id
          AND candidate.workspace_owner_id = previous.workspace_owner_id
          AND (
            candidate.status = 'candidate'
            OR ($3 = 'deactivated' AND candidate.status = 'approved')
          )
       RETURNING candidate.*
     ), decision AS (
       INSERT INTO base_item_metadata_candidate_decisions (
         workspace_owner_id, candidate_id, action, actor_user_id,
         previous_state, next_state, note
       )
       SELECT $2, updated.id, $6, $4, to_jsonb(previous), to_jsonb(updated), $5
         FROM updated
         JOIN previous ON previous.id = updated.id
     )
     SELECT * FROM updated`,
    [
      id,
      wreq.workspaceOwnerId,
       status,
      authed(req).userId ?? null,
      parsed.data.note ?? null,
       isEdit ? "corrected" : parsed.data.action === "approve"
        ? "approved"
        : parsed.data.action === "reject" ? "rejected" : "deactivated",
       isEdit,
       JSON.stringify(parsed.data.proposed_value ?? {}),
       parsed.data.source_text !== undefined,
       parsed.data.source_text ?? null,
    ],
  );
  if (!result.rows[0]) {
    res.status(409).json({ error: "Metadata candidate cannot be changed in its current state" });
    return;
  }
  res.json({ candidate: result.rows[0] });
});

router.get("/recipe-intelligence/base-item-aliases", async (req, res) => {
  const wreq = workspace(req);
  if (rejectUnauthorized(wreq, res)) return;
  const result = await db.query(
    `SELECT alias.id, alias.base_item_id, bi.name AS base_item_name,
            alias.alias, alias.normalized_alias,
            alias.source_type, alias.status, alias.decided_by_user_id,
            alias.decided_at, alias.decision_note, alias.created_at, alias.updated_at
       FROM base_item_aliases alias
       JOIN base_items bi
         ON bi.id = alias.base_item_id
        AND bi.workspace_owner_id = alias.workspace_owner_id
      WHERE alias.workspace_owner_id = $1
      ORDER BY CASE alias.status WHEN 'candidate' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
               alias.created_at DESC, alias.id DESC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ aliases: result.rows });
});

router.post("/recipe-intelligence/base-item-aliases/:id/decision", async (req, res) => {
  const wreq = workspace(req);
  if (rejectUnauthorized(wreq, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid Base Item alias id" });
    return;
  }
  const parsed = aliasDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid alias decision", details: parsed.error.issues });
    return;
  }
  const isEdit = parsed.data.action === "edit";
  const status = parsed.data.action === "approve"
    ? "approved"
    : parsed.data.action === "reject" ? "rejected" : parsed.data.action === "deactivate" ? "deactivated" : "candidate";
  const normalizedAlias = parsed.data.alias?.trim().toLocaleLowerCase() ?? null;
  const result = await db.query(
    `WITH previous AS (
       SELECT * FROM base_item_aliases
        WHERE id = $1 AND workspace_owner_id = $2
        FOR UPDATE
     ), updated AS (
       UPDATE base_item_aliases alias
          SET status = $3,
               alias = CASE WHEN $7 THEN $8 ELSE alias.alias END,
               normalized_alias = CASE WHEN $7 THEN $9 ELSE alias.normalized_alias END,
               decided_by_user_id = CASE WHEN $7 THEN alias.decided_by_user_id ELSE $4 END,
               decided_at = CASE WHEN $7 THEN alias.decided_at ELSE now() END,
               decision_note = CASE WHEN $7 THEN alias.decision_note ELSE $5 END,
              updated_at = now()
         FROM previous
        WHERE alias.id = previous.id
          AND alias.workspace_owner_id = previous.workspace_owner_id
          AND (
            alias.status = 'candidate'
            OR ($3 = 'deactivated' AND alias.status = 'approved')
          )
       RETURNING alias.*
     ), decision AS (
       INSERT INTO base_item_alias_decisions (
         workspace_owner_id, alias_id, action, actor_user_id,
         previous_state, next_state, note
       )
       SELECT $2, updated.id, $6, $4, to_jsonb(previous), to_jsonb(updated), $5
         FROM updated JOIN previous ON previous.id = updated.id
     )
     SELECT * FROM updated`,
    [
      id,
      wreq.workspaceOwnerId,
      status,
      authed(req).userId ?? null,
      parsed.data.note ?? null,
       isEdit ? "corrected" : status === "deactivated" ? "deactivated" : status,
       isEdit,
       parsed.data.alias ?? null,
       normalizedAlias,
    ],
  );
  if (!result.rows[0]) {
    res.status(409).json({ error: "Alias cannot be changed in its current state" });
    return;
  }
  res.json({ alias: result.rows[0] });
});

router.post("/recipe-intelligence/rules/:id/decision", async (req, res) => {
  const wreq = workspace(req);
  if (rejectUnauthorized(wreq, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid recipe rule id" });
    return;
  }
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid rule decision", details: parsed.error.issues });
    return;
  }

  // This read is only used to retain the historical 404 response.  It must
  // not be used to decide a transition: that decision is made from the row
  // locked by the CTE below.
  const existingResult = await db.query<RuleRow>(
    `SELECT id, workspace_owner_id, rule_key, name, description, rule_type,
            source, status, definition, confidence, created_by_user_id,
            decided_by_user_id, decided_at, created_at, updated_at
       FROM recipe_rules
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  const existing = existingResult.rows[0];
  if (!existing) {
    res.status(404).json({ error: "Recipe rule not found" });
    return;
  }

  const input = parsed.data;
  let nextDefinition: Record<string, unknown> = input.definition
    ? {
        ...input.definition,
        ...(existing.definition.proposed_scope
          ? { proposed_scope: existing.definition.proposed_scope }
          : {}),
      }
    : { ...existing.definition };
  if (input.action === "approve" || input.action === "edit") {
    const scopeError = validateStoredRuleScope(nextDefinition);
    if (scopeError) {
      res.status(400).json({ error: scopeError });
      return;
    }
    if (nextDefinition.proposed_scope) {
      // Runtime consumes resolver_base_item_id. Accept the older key only as
      // an input migration, then persist the canonical runtime field.
      const resolverBaseItemId = Number(nextDefinition.resolver_base_item_id ?? nextDefinition.base_item_id);
      if (!Number.isInteger(resolverBaseItemId) || resolverBaseItemId <= 0) {
        res.status(400).json({ error: "Scoped rules require a resolver Base Item" });
        return;
      }
      const resolver = await db.query(
        `SELECT id FROM base_items
          WHERE id = $1 AND workspace_owner_id = $2
            AND COALESCE(status, 'active') = 'active'
            AND archived_at IS NULL`,
        [resolverBaseItemId, wreq.workspaceOwnerId],
      );
      if (!resolver.rows[0]) {
        res.status(400).json({ error: "Resolver Base Item is not active in this workspace" });
        return;
      }
      nextDefinition.resolver_base_item_id = resolverBaseItemId;
      delete nextDefinition.base_item_id;
    }
  }
  const shouldPersistDefinition = input.definition !== undefined
    || ((input.action === "approve" || input.action === "edit") && Boolean(nextDefinition.proposed_scope));
  const updateResult = await db.query<RuleRow>(
    `WITH previous AS (
        SELECT *
          FROM recipe_rules
         WHERE id = $1
           AND workspace_owner_id = $2
         FOR UPDATE
      ), updated AS (
       UPDATE recipe_rules
           SET name = COALESCE($3, recipe_rules.name),
               description = CASE WHEN $4 THEN $5 ELSE recipe_rules.description END,
               definition = CASE WHEN $6 THEN $7::jsonb ELSE recipe_rules.definition END,
               confidence = CASE WHEN $8 THEN $9 ELSE recipe_rules.confidence END,
               status = CASE
                 WHEN $10 = 'approve' THEN 'approved'
                 WHEN $10 = 'reject' THEN 'rejected'
                 WHEN $10 IN ('deactivate', 'rollback') THEN 'inactive'
                 ELSE recipe_rules.status
               END,
               decided_by_user_id = CASE WHEN $11 THEN $12 ELSE recipe_rules.decided_by_user_id END,
               decided_at = CASE WHEN $11 THEN now() ELSE recipe_rules.decided_at END,
              updated_at = now()
          FROM previous
         WHERE recipe_rules.id = previous.id
           AND recipe_rules.workspace_owner_id = previous.workspace_owner_id
           AND (
             ($10 IN ('approve', 'reject', 'edit') AND previous.status = 'candidate')
             OR ($10 IN ('deactivate', 'rollback') AND previous.status = 'approved')
           )
         RETURNING recipe_rules.*
     ), action_log AS (
       INSERT INTO recipe_rule_actions (
         workspace_owner_id, rule_id, action, actor_user_id, previous_state,
         next_state, note
       )
        SELECT $2, updated.id, $13, $14, to_jsonb(previous), to_jsonb(updated), $15
          FROM updated
          JOIN previous ON previous.id = updated.id
     )
     SELECT * FROM updated`,
    [
      id,
      wreq.workspaceOwnerId,
      input.name ?? null,
      input.description !== undefined,
      input.description ?? null,
      shouldPersistDefinition,
      JSON.stringify(shouldPersistDefinition ? nextDefinition : {}),
      input.confidence !== undefined,
      input.confidence ?? null,
      input.action,
       input.action !== "edit",
      authed(req).userId ?? null,
      input.action === "approve"
        ? "approved"
        : input.action === "reject"
          ? "rejected"
          : input.action === "deactivate"
            ? "deactivated"
            : input.action === "rollback"
              ? "rolled_back"
              : "edited",
      authed(req).userId ?? null,
      input.note ?? null,
    ],
  );
  const rule = updateResult.rows[0];
  if (!rule) {
    res.status(409).json({ error: "Recipe rule cannot be changed in its current state" });
    return;
  }
  res.json({ rule });
});

router.post("/recipe-intelligence/rules/discover", async (req, res) => {
  const wreq = workspace(req);
  if (rejectUnauthorized(wreq, res)) return;
  const audit = await analyzeRecipeWorkspace(wreq.workspaceOwnerId);
  // Capturing an audit preserves its exact supporting/conflicting examples for
  // both the two seeded deterministic rules and discovered candidates. Rule
  // status is deliberately never changed here; all remain inactive candidates
  // until an explicit approval decision.
  const candidates = audit.candidate_rules;
  const created: Array<{ id: number; rule_key: string }> = [];

  for (const candidate of candidates) {
    const rule = await upsertCandidateRule(wreq.workspaceOwnerId, authed(req).userId ?? null, candidate);
    created.push({ id: rule.id, rule_key: candidate.rule_key });
  }
  res.status(201).json({ rules: created, count: created.length });
});

export async function upsertCandidateRule(
  workspaceOwnerId: string,
  userId: string | null,
  candidate: RecipeRuleCandidate,
): Promise<{ id: number }> {
  const existingResult = await db.query<RuleRow>(
    `SELECT id, workspace_owner_id, rule_key, name, description, rule_type,
            source, status, definition, confidence, created_by_user_id,
            decided_by_user_id, decided_at, created_at, updated_at
       FROM recipe_rules
      WHERE workspace_owner_id = $1 AND rule_key = $2`,
    [workspaceOwnerId, candidate.rule_key],
  );
  const existing = existingResult.rows[0];

  // A manager's approval/rejection (and an explicitly manual rule) is an
  // immutable governance decision. Later audits may report new observations,
  // but never rewrite the definition that was reviewed.
  if (existing && (
    existing.status !== "candidate"
    || existing.source !== "discovered"
  )) {
    await recordRuleEvidence(workspaceOwnerId, existing.id, candidate);
    return { id: existing.id };
  }

  const ruleResult = existing
    ? await db.query<RuleRow>(
      `UPDATE recipe_rules
          SET name = $3,
              description = $4,
              definition = $5::jsonb,
              confidence = $6,
              updated_at = now()
        WHERE id = $1
          AND workspace_owner_id = $2
          AND status = 'candidate'
          AND source = 'discovered'
        RETURNING id, workspace_owner_id, rule_key, name, description, rule_type,
                  source, status, definition, confidence, created_by_user_id,
                  decided_by_user_id, decided_at, created_at, updated_at`,
      [
        existing.id,
        workspaceOwnerId,
        candidate.name,
        candidate.description,
        JSON.stringify(candidate.definition),
        candidate.confidence,
      ],
    )
    : await db.query<RuleRow>(
      `INSERT INTO recipe_rules (
       workspace_owner_id, rule_key, name, description, rule_type, source,
       status, definition, confidence, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 'candidate', $7::jsonb, $8, $9)
     RETURNING id, workspace_owner_id, rule_key, name, description, rule_type,
               source, status, definition, confidence, created_by_user_id,
               decided_by_user_id, decided_at, created_at, updated_at`,
      [
        workspaceOwnerId,
        candidate.rule_key,
        candidate.name,
        candidate.description,
        candidate.rule_type,
        candidate.source,
        JSON.stringify(candidate.definition),
        candidate.confidence,
        userId,
      ],
    );
  const rule = ruleResult.rows[0]!;
  await recordRuleEvidence(workspaceOwnerId, rule.id, candidate);
  await db.query(
    `INSERT INTO recipe_rule_actions (
       workspace_owner_id, rule_id, action, actor_user_id, previous_state, next_state
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      workspaceOwnerId,
      rule.id,
      candidate.source === "deterministic" ? "seeded" : "discovered",
      userId,
      JSON.stringify(existing ?? {}),
      JSON.stringify(rule),
    ],
  );
  return rule;
}

async function recordRuleEvidence(
  workspaceOwnerId: string,
  ruleId: number,
  candidate: RecipeRuleCandidate,
): Promise<void> {
  const evidence = [...candidate.supporting_evidence, ...candidate.conflicting_evidence];
  for (const row of evidence) {
    await db.query(
      `INSERT INTO recipe_rule_evidence (
         workspace_owner_id, rule_id, evidence_type, product_id, base_item_id,
         product_name_snapshot, base_item_name_snapshot, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        workspaceOwnerId,
        ruleId,
        row.evidence_type,
        row.product_id,
        row.base_item_id,
        row.product_name_snapshot,
        row.base_item_name_snapshot,
        JSON.stringify(row.details),
      ],
    );
  }
}

export default router;