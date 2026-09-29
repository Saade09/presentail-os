import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { db } from "../lib/db";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  extractProductStructure,
  extractRecipeRequirements,
  evaluateCandidateCompatibility,
  isGovernedOperationalHiddenRuleKey,
  isSupportedRecipeRequirementSubtype,
  generateRecipeSuggestion,
  RECIPE_SUGGESTION_ALIAS_VERSION,
  RECIPE_SUGGESTION_ENGINE_VERSION,
  RECIPE_SUGGESTION_METADATA_VERSION,
  RECIPE_SUGGESTION_PROMPT_VERSION,
  RECIPE_SUGGESTION_RULESET_VERSION,
  type RecipeLineInput,
  type RecipeRequirement,
  type SuggestionConfidence,
  type SuggestionLine,
  type SuggestionProduct,
} from "../lib/recipeSuggestionEngine";
import {
  loadRecipeGenerationRuntime,
  type RuntimeBaseItemRow,
  type RuntimeRuleRow,
} from "../lib/recipeGenerationRuntime";
import { ensureDeterministicRecipeRules } from "../lib/recipeIntelligence";
import { callAI } from "../lib/ai/callAI";

/**
 * A saved recipe suggestion is deliberately not a recipe. The only write to
 * product_recipes in this module happens in the explicit approval transaction.
 */
const router = Router();
router.use(requireAuth, resolveWorkspace);

const confidenceScore: Record<SuggestionConfidence, number> = {
  high: 0.95,
  medium: 0.7,
  low: 0.4,
  no_match: 0,
};

type ProductRow = {
  id: number;
  name: string;
  description: string | null;
  description_ar: string | null;
  main_image_url: string | null;
  additional_image_urls: string[] | null;
  tags: string[] | null;
  category: string | null;
  recipe_version?: number;
};

export type BaseItemRow = RuntimeBaseItemRow;

type RecipeRow = {
  product_id: number;
  base_item_id: number;
  base_item_name: string;
  base_item_code: string | null;
  quantity: string | number;
};

type RuleRow = RuntimeRuleRow & { name: string };

type StoredLine = {
  id: number;
  line_order: number;
  proposed_base_item_id: number | null;
  proposed_base_item_name: string | null;
  proposed_base_item_code: string | null;
  extracted_requirement: string | null;
  unit_context: string | null;
  source_evidence: unknown;
  match_confidence: SuggestionConfidence;
  quantity: string | number;
  confidence: string | number | null;
  source_type: string;
  source_rule_id: number | null;
  rationale: string | null;
  resolution_status: "resolved" | "unresolved" | "excluded";
  exclusion_reason: string | null;
  exclusion_acknowledged: boolean;
  created_at: string;
};

type StoredSuggestion = {
  id: number;
  workspace_owner_id: string;
  product_id: number | null;
  version: number;
  version_manifest: Record<string, unknown>;
  status: string;
  generation_context: Record<string, unknown>;
  confidence: string | number | null;
  rationale: string | null;
  created_by_user_id: string | null;
  created_at: string;
};

export type DraftLine = {
  baseItemId: number | null;
  baseItemName: string | null;
  baseItemCode: string | null;
  extractedRequirement: string;
  unitContext: string | null;
  quantity: number;
  confidence: SuggestionConfidence;
  sourceType: string;
  sourceRuleId: number | null;
  rationale: string;
  evidence: unknown[];
  requirementId?: string | null;
  resolutionStatus?: "resolved" | "unresolved" | "excluded";
  exclusionReason?: string | null;
  exclusionAcknowledged?: boolean;
};

function canManage(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes("products.manage");
}

function requireProductManagement(wreq: ReturnType<typeof workspace>, res: { status: (status: number) => { json: (body: unknown) => void } }): boolean {
  if (canManage(wreq)) return true;
  res.status(403).json({
    error: "Managing recipe suggestions requires owner access or the Manage products permission",
  });
  return false;
}

type RecipeAttentionRow = {
  product_id: number;
  missing_recipe: boolean;
  suggestion_id: number | null;
  version: number | null;
  confidence: string | number | null;
  created_at: string | null;
};

/**
 * Workspace-wide queue data used by both the recipe review page and the
 * sidebar attention badge. Suggestions are deliberately joined per product,
 * so a product with both kinds of work is represented once in the count.
 */
router.get("/products/recipe-review-summary", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!requireProductManagement(wreq, res)) return;

  const result = await db.query<RecipeAttentionRow>(
    `SELECT p.id AS product_id,
            NOT EXISTS (
              SELECT 1
                FROM product_recipes pr
               WHERE pr.workspace_owner_id = p.workspace_owner_id
                 AND pr.product_id = p.id
            ) AS missing_recipe,
            suggestion.id AS suggestion_id,
            suggestion.version,
            suggestion.confidence,
            suggestion.created_at
       FROM products p
       LEFT JOIN LATERAL (
         SELECT rs.id, rs.version, rs.confidence, rs.created_at
           FROM recipe_suggestions rs
          WHERE rs.workspace_owner_id = p.workspace_owner_id
            AND rs.product_id = p.id
            AND rs.status IN ('draft', 'generated', 'under_review')
          ORDER BY rs.created_at DESC, rs.id DESC
          LIMIT 1
       ) suggestion ON true
      WHERE p.workspace_owner_id = $1
        AND COALESCE(p.is_archived, false) = false
        AND COALESCE(p.status, 'available') <> 'archived'
      ORDER BY p.id ASC`,
    [wreq.workspaceOwnerId],
  );

  const productsWithoutRecipe: number[] = [];
  const productsWithPendingSuggestion: Array<{
    product_id: number;
    suggestion_id: number;
    version: number;
    confidence: number | null;
    created_at: string;
  }> = [];
  const attentionProductIds = new Set<number>();

  for (const row of result.rows) {
    if (row.missing_recipe) {
      productsWithoutRecipe.push(row.product_id);
      attentionProductIds.add(row.product_id);
    }
    if (row.suggestion_id != null && row.version != null && row.created_at != null) {
      productsWithPendingSuggestion.push({
        product_id: row.product_id,
        suggestion_id: row.suggestion_id,
        version: row.version,
        confidence: row.confidence == null ? null : Number(row.confidence),
        created_at: row.created_at,
      });
      attentionProductIds.add(row.product_id);
    }
  }

  res.json({
    attention_count: attentionProductIds.size,
    products_without_recipe: productsWithoutRecipe,
    products_with_pending_suggestion: productsWithPendingSuggestion,
  });
});

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function recipeLine(row: RecipeRow): RecipeLineInput {
  return {
    baseItemId: row.base_item_id,
    baseItemName: row.base_item_name,
    baseItemCode: row.base_item_code,
    quantity: Number(row.quantity),
  };
}

function confidenceFromScore(value: number | null | undefined): SuggestionConfidence {
  if (value == null || value <= 0) return "no_match";
  if (value >= 0.85) return "high";
  if (value >= 0.55) return "medium";
  return "low";
}

function serializeLine(line: StoredLine) {
  return {
    id: line.id,
    line_order: line.line_order,
    extracted_requirement: line.extracted_requirement,
    selected_base_item: line.proposed_base_item_id == null
      ? null
      : {
          id: line.proposed_base_item_id,
          name: line.proposed_base_item_name,
          code: line.proposed_base_item_code,
        },
    quantity: Number(line.quantity),
    unit_context: line.unit_context,
    confidence: line.match_confidence ?? confidenceFromScore(
      line.confidence == null ? null : Number(line.confidence),
    ),
    source_type: line.source_type,
    source_rule_id: line.source_rule_id,
    sources: Array.isArray(line.source_evidence) ? line.source_evidence : [],
    rationale: line.rationale,
    resolution_status: line.resolution_status,
    exclusion_reason: line.exclusion_reason,
    exclusion_acknowledged: line.exclusion_acknowledged,
    created_at: line.created_at,
  };
}

function sourceRuleKey(line: SuggestionLine): string | null {
  if (line.hiddenRuleKey?.startsWith("balloon_")) return "balloon-metal-ring";
  if (line.hiddenRuleKey?.startsWith("flower_box_")) return "flower-box-sponge";
  return null;
}

export function toDraftLines(
  generated: ReturnType<typeof generateRecipeSuggestion>,
  baseItems: BaseItemRow[],
  rules: RuleRow[],
  aiLines: DraftLine[],
): DraftLine[] {
  const itemById = new Map(baseItems.map((item) => [item.id, item]));
  const ruleIdByKey = new Map(rules.map((rule) => [rule.rule_key, rule.id]));
  const resolved = generated.lines.map((line) => {
    const item = itemById.get(line.baseItemId);
    const ruleKey = sourceRuleKey(line);
    const requirement = line.requirementId
      ? generated.requirements.find((candidate) => candidate.requirementId === line.requirementId)
      : null;
    const supportingProductIds = requirement?.similarEvidence
      .find((evidence) => evidence.baseItemId === line.baseItemId)
      ?.supportingProductIds ?? [];
    return {
      baseItemId: line.baseItemId,
      baseItemName: line.baseItemName,
      baseItemCode: line.baseItemCode ?? item?.code ?? null,
      extractedRequirement: line.reason,
      unitContext: item?.canonical_unit ?? null,
      quantity: line.quantity,
      confidence: line.confidence,
      sourceType: line.source,
      sourceRuleId: ruleKey ? ruleIdByKey.get(ruleKey) ?? null : null,
      rationale: line.reason,
      evidence: [{
        type: line.source,
        requirement_id: line.requirementId,
        requirement_provenance: line.requirementProvenance ?? (
          line.requirementEvidence ? { evidence: line.requirementEvidence, quantity: line.quantity } : null
        ),
        contextual_rule_provenance: line.contextualRuleProvenance ?? null,
        hidden_rule_key: line.hiddenRuleKey,
        supporting_product_ids: supportingProductIds,
      }],
      requirementId: line.requirementId,
    } satisfies DraftLine;
  });
  const aiRequirementIds = new Set(aiLines.map((line) => line.requirementId).filter(Boolean));
  const unmatched = generated.unresolvedLines.flatMap((requirement, index) => {
    const detail = generated.unresolvedRequirements[index];
    if (detail?.requirementId && aiRequirementIds.has(detail.requirementId)) return [];
    return [{
      baseItemId: null,
      baseItemName: null,
      baseItemCode: null,
      extractedRequirement: requirement,
      unitContext: null,
      quantity: detail?.quantity ?? 1,
      confidence: "no_match" as const,
      sourceType: "unresolved",
      sourceRuleId: null,
      rationale: detail?.reason ?? "No safe existing Base Item match was found. Review is required.",
      evidence: [{
        type: "unresolved",
        requirement_id: detail?.requirementId,
        requirement_provenance: detail?.requirementProvenance ?? null,
        requirement,
        candidate_base_item_ids: detail?.candidateBaseItemIds ?? [],
      }],
      requirementId: detail?.requirementId ?? null,
    }];
  });
  return [
    ...resolved,
    ...aiLines,
    ...unmatched,
  ];
}

function approvedRuleLines(
  target: Omit<SuggestionProduct, "recipes">,
  baseItems: BaseItemRow[],
  rules: RuleRow[],
  existingBaseItemIds: Set<number>,
): DraftLine[] {
  const text = [target.name, target.description ?? "", target.category ?? "", ...(target.tags ?? [])]
    .join(" ")
    .toLowerCase();
  const lines: DraftLine[] = [];
  const structure = extractProductStructure(target);

  for (const rule of rules) {
    const canonicalFormats = Array.isArray(rule.definition.canonical_formats)
      ? rule.definition.canonical_formats.filter((value): value is string => typeof value === "string")
      : [];
    const resolverBaseItemId = Number(rule.definition.resolver_base_item_id);
    if (canonicalFormats.length > 0 && Number.isInteger(resolverBaseItemId) && resolverBaseItemId > 0) {
      if (structure.conflicts.length > 0 || structure.productFormat.confidence !== "high") continue;
      if (!canonicalFormats.includes(structure.productFormat.value ?? "")) continue;
      const ingredientFamily = typeof rule.definition.ingredient_family === "string"
        ? rule.definition.ingredient_family.toLowerCase()
        : null;
      const color = typeof rule.definition.color === "string"
        ? rule.definition.color.toLowerCase()
        : null;
      if (ingredientFamily && structure.ingredientFamily.value?.toLowerCase() !== ingredientFamily) continue;
      if (color && structure.color.value?.toLowerCase() !== color) continue;
      const selected = baseItems.find((item) => item.id === resolverBaseItemId);
      if (!selected) {
        lines.push({
          baseItemId: null,
          baseItemName: null,
          baseItemCode: null,
          extractedRequirement: `Active contextual rule "${rule.name}" references an unavailable Base Item.`,
          unitContext: null,
          quantity: 1,
          confidence: "no_match",
          sourceType: "unresolved",
          sourceRuleId: rule.id,
          rationale: "The approved resolver Base Item is inactive, archived, or no longer available.",
          evidence: [{ type: "approved_contextual_rule", rule_id: rule.id, rule_key: rule.rule_key }],
        });
        continue;
      }
      if (existingBaseItemIds.has(selected.id)) continue;
      existingBaseItemIds.add(selected.id);
      lines.push({
        baseItemId: selected.id,
        baseItemName: selected.name,
        baseItemCode: selected.code,
        extractedRequirement: `Active contextual rule "${rule.name}" resolved the structured product format and ingredient.`,
        unitContext: selected.canonical_unit,
        quantity: 1,
        confidence: "high",
        sourceType: "deterministic_rule",
        sourceRuleId: rule.id,
        rationale: "Approved workspace-scoped contextual rule resolved by exact Base Item ID.",
        evidence: [{
          type: "approved_contextual_rule",
          rule_id: rule.id,
          rule_key: rule.rule_key,
          canonical_format: structure.productFormat.value,
          resolver_base_item_id: selected.id,
        }],
      });
      continue;
    }
    const productKeywords = Array.isArray(rule.definition.product_keywords)
      ? rule.definition.product_keywords.filter((value): value is string => typeof value === "string")
      : [];
    const requiredKeywords = Array.isArray(rule.definition.required_base_item_keywords)
      ? rule.definition.required_base_item_keywords.filter((value): value is string => typeof value === "string")
      : [];
    if (productKeywords.length === 0 || requiredKeywords.length === 0) continue;
    if (!productKeywords.every((keyword) => text.includes(keyword.toLowerCase()))) continue;

    const matches = baseItems.filter((item) => {
      const itemText = `${item.name} ${item.code ?? ""} ${item.package_name ?? ""}`.toLowerCase();
      return requiredKeywords.every((keyword) => itemText.includes(keyword.toLowerCase()));
    });
    if (matches.length === 0) {
      lines.push({
        baseItemId: null,
        baseItemName: null,
        baseItemCode: null,
        extractedRequirement: `Active rule "${rule.name}" requires ${requiredKeywords.join(" + ")}.`,
        unitContext: null,
        quantity: 1,
        confidence: "no_match",
        sourceType: "unresolved",
        sourceRuleId: rule.id,
        rationale: "An approved rule applied but no compatible existing Base Item was found.",
        evidence: [{ type: "approved_rule", rule_id: rule.id, rule_key: rule.rule_key }],
      });
      continue;
    }
    if (matches.length > 1) {
      lines.push({
        baseItemId: null,
        baseItemName: null,
        baseItemCode: null,
        extractedRequirement: `Active rule "${rule.name}" has multiple compatible Base Item variants.`,
        unitContext: null,
        quantity: 1,
        confidence: "no_match",
        sourceType: "unresolved",
        sourceRuleId: rule.id,
        rationale: "An approved rule cannot select among multiple credible variants without an approved resolver.",
        evidence: [{
          type: "approved_rule_ambiguity",
          rule_id: rule.id,
          rule_key: rule.rule_key,
          candidate_base_item_ids: matches.map((item) => item.id),
        }],
      });
      continue;
    }
    const selected = matches[0];
    if (existingBaseItemIds.has(selected.id)) continue;
    existingBaseItemIds.add(selected.id);
    const configuredQuantity = Number(rule.definition.quantity);
    lines.push({
      baseItemId: selected.id,
      baseItemName: selected.name,
      baseItemCode: selected.code,
      extractedRequirement: `Active rule "${rule.name}" requires ${requiredKeywords.join(" + ")}.`,
      unitContext: selected.canonical_unit,
      quantity: Number.isFinite(configuredQuantity) && configuredQuantity > 0 ? configuredQuantity : 1,
      confidence: "high",
      sourceType: "deterministic_rule",
      sourceRuleId: rule.id,
      rationale: `Approved active rule "${rule.name}" matched the product and Base Item metadata.`,
      evidence: [{ type: "approved_rule", rule_id: rule.id, rule_key: rule.rule_key }],
    });
  }
  return lines;
}

const boundedAiResponseSchema = z.object({
  requirement_id: z.string().min(1),
  choice: z.object({
    base_item_id: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(500),
  }).nullable(),
});

export function validateBoundedAiChoice(
  requirement: ReturnType<typeof generateRecipeSuggestion>["unresolvedRequirements"][number],
  candidateItems: BaseItemRow[],
  payload: unknown,
): DraftLine | null {
  const parsed = boundedAiResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.requirement_id !== requirement.requirementId || !parsed.data.choice) return null;
  const choice = parsed.data.choice;
  const allowedIds = new Set(requirement.candidateBaseItemIds ?? []);
  const item = candidateItems.find((candidate) =>
    candidate.id === choice.base_item_id && allowedIds.has(candidate.id),
  );
  if (!item || choice.confidence < 0.7) return null;
  const diagnostic = requirement.requirementProvenance?.candidateCompatibility
    ?.find(({ baseItemId }) => baseItemId === item.id);
  if (diagnostic && (!diagnostic.survivor || diagnostic.hasUnknownExplicitDiscriminator)) return null;
  return {
    baseItemId: item.id,
    baseItemName: item.name,
    baseItemCode: item.code,
    extractedRequirement: requirement.requirement,
    unitContext: item.canonical_unit,
    quantity: requirement.quantity,
    confidence: confidenceFromScore(choice.confidence),
    sourceType: "ai_assisted",
    sourceRuleId: null,
    rationale: choice.rationale,
    evidence: [{
      type: "ai_assisted",
      confidence: choice.confidence,
      requirement_id: requirement.requirementId,
      candidate_base_item_ids: requirement.candidateBaseItemIds ?? [],
      requirement_provenance: requirement.requirementProvenance ?? null,
    }],
    requirementId: requirement.requirementId,
  };
}

async function boundedAiAssistance(
  target: Omit<SuggestionProduct, "recipes">,
  baseItems: BaseItemRow[],
  unresolvedRequirements: ReturnType<typeof generateRecipeSuggestion>["unresolvedRequirements"],
  workspaceOwnerId: string,
): Promise<{ lines: DraftLine[]; outcome: string }> {
  // AI is intentionally unavailable unless structured matching left an
  // unresolved requirement. It receives only this workspace's supplied Base
  // Item identifiers and output is revalidated before it can enter a draft.
  if (unresolvedRequirements.length === 0) return { lines: [], outcome: "not_needed" };
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    return { lines: [], outcome: "unavailable" };
  }

  try {
    const model = process.env.RECIPE_SUGGESTION_MODEL ?? "gpt-4o-mini";
    const lines: DraftLine[] = [];
    for (const requirement of unresolvedRequirements) {
      const candidateIds = new Set(requirement.candidateBaseItemIds ?? []);
      if (candidateIds.size === 0) continue;
      const candidateItems = baseItems.filter((item) => candidateIds.has(item.id));
      const response = await callAI({
      actionKey: "recipes.suggestion_assistance",
      surface: "recipe_suggestions",
      provider: "openai",
      model,
      sessionId: `workspace:${workspaceOwnerId}`,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{
        role: "system",
        content: "Return JSON only. Return the supplied requirement_id unchanged and select only one supplied base_item_id. Do not return or alter quantity. Return choice null when unsure.",
      }, {
        role: "user",
        content: JSON.stringify({
          product: {
            name: target.name,
            description: target.description,
            description_ar: target.descriptionAr,
            category: target.category,
            tags: target.tags,
          },
          requirement,
          base_items: candidateItems.map((item) => ({
            base_item_id: item.id,
            name: item.name,
            code: item.code,
            unit: item.canonical_unit,
            package: item.package_name,
          })),
        }),
      }],
    });
      const payload = JSON.parse(response.choices[0]?.message.content ?? "{}");
      const line = validateBoundedAiChoice(requirement, candidateItems, payload);
      if (line) lines.push(line);
    }
    return { lines, outcome: lines.length > 0 ? "applied_review_required" : "uncertain" };
  } catch {
    // A provider failure must never alter the live recipe or turn a guess into
    // a match. The unresolved draft remains fully reviewable.
    return { lines: [], outcome: "unavailable" };
  }
}

async function insertDraftLines(
  client: PoolClient,
  workspaceOwnerId: string,
  suggestionId: number,
  lines: DraftLine[],
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    await client.query(
      `INSERT INTO recipe_suggestion_lines (
         workspace_owner_id, suggestion_id, line_order, proposed_base_item_id,
         proposed_base_item_name, proposed_base_item_code, extracted_requirement,
         unit_context, source_evidence, match_confidence, quantity, confidence,
          source_type, source_rule_id, rationale, resolution_status, exclusion_reason, exclusion_acknowledged
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        workspaceOwnerId,
        suggestionId,
        index,
        line.baseItemId,
        line.baseItemName,
        line.baseItemCode,
        line.extractedRequirement,
        line.unitContext,
        JSON.stringify(line.evidence),
        line.confidence,
        line.quantity,
        confidenceScore[line.confidence],
        line.sourceType,
        line.sourceRuleId,
        line.rationale,
        line.resolutionStatus ?? (line.baseItemId == null ? "unresolved" : "resolved"),
        line.exclusionReason ?? null,
        line.exclusionAcknowledged ?? false,
      ],
    );
  }
}

async function suggestionDetail(
  suggestionId: number,
  workspaceOwnerId: string,
): Promise<{ suggestion: StoredSuggestion; lines: StoredLine[]; actions: unknown[]; corrections: unknown[]; liveRecipe: RecipeRow[]; liveRecipeVersion: number } | null> {
  const result = await db.query<StoredSuggestion>(
    `SELECT id, workspace_owner_id, product_id, version, version_manifest, status, generation_context,
            confidence, rationale, created_by_user_id, created_at
       FROM recipe_suggestions
      WHERE id = $1 AND workspace_owner_id = $2`,
    [suggestionId, workspaceOwnerId],
  );
  const suggestion = result.rows[0];
  if (!suggestion) return null;
  const [lines, actions, corrections, liveRecipe, liveRecipeVersion] = await Promise.all([
    db.query<StoredLine>(
      `SELECT id, line_order, proposed_base_item_id, proposed_base_item_name,
              proposed_base_item_code, extracted_requirement, unit_context,
              source_evidence, match_confidence, quantity, confidence, source_type,
              source_rule_id, rationale, resolution_status, exclusion_reason,
              exclusion_acknowledged, created_at
         FROM recipe_suggestion_lines
        WHERE suggestion_id = $1 AND workspace_owner_id = $2
        ORDER BY line_order ASC, id ASC`,
      [suggestionId, workspaceOwnerId],
    ),
    db.query(
      `SELECT id, action, actor_user_id, note, context, created_at
         FROM recipe_suggestion_actions
        WHERE suggestion_id = $1 AND workspace_owner_id = $2
        ORDER BY created_at ASC, id ASC`,
      [suggestionId, workspaceOwnerId],
    ),
    db.query(
      `SELECT id, line_id, correction_type, extraction_error_type, original_structured_requirement,
              corrected_structured_requirement, original_line, corrected_line, product_context,
              format_context, reason, note, actor_user_id, intent, proposed_scope,
              candidate_alias_id, candidate_rule_id, candidate_metadata_id, before_evidence,
              after_evidence, created_at
         FROM recipe_suggestion_corrections
        WHERE suggestion_id = $1 AND workspace_owner_id = $2
        ORDER BY created_at ASC, id ASC`,
      [suggestionId, workspaceOwnerId],
    ),
    suggestion.product_id == null ? Promise.resolve({ rows: [] as RecipeRow[] }) : db.query<RecipeRow>(
      `SELECT pr.product_id, pr.base_item_id, bi.name AS base_item_name, bi.code AS base_item_code,
              pr.quantity::text AS quantity
         FROM product_recipes pr JOIN base_items bi ON bi.id = pr.base_item_id
        WHERE pr.product_id = $1 AND pr.workspace_owner_id = $2 ORDER BY pr.sort_order ASC, pr.id ASC`,
      [suggestion.product_id, workspaceOwnerId],
    ),
    suggestion.product_id == null ? Promise.resolve({ rows: [{ recipe_version: 0 }] }) : db.query<{ recipe_version: number }>(
      `SELECT recipe_version FROM products WHERE id = $1 AND workspace_owner_id = $2`,
      [suggestion.product_id, workspaceOwnerId],
    ),
  ]);
  return { suggestion, lines: lines.rows, actions: actions.rows, corrections: corrections.rows,
    liveRecipe: liveRecipe.rows, liveRecipeVersion: Number(liveRecipeVersion.rows[0]?.recipe_version ?? 0) };
}

const noteSchema = z.object({
  note: z.string().trim().max(2_000).nullable().optional(),
});

const correctionSchema = z.object({
  correction_type: z.enum(["replace_base_item", "change_quantity", "add_line", "remove_line", "correct_requirement", "preserve_unresolved"]),
  line_id: z.number().int().positive().nullable().optional(),
  extraction_error_type: z.string().trim().max(100).nullable().optional(),
  reason: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2_000).nullable().optional(),
  intent: z.enum(["product_only", "propose_learning"]).default("product_only"),
  base_item_id: z.number().int().positive().nullable().optional(),
  quantity: z.number().positive().max(100_000).optional(),
  extracted_requirement: z.string().trim().min(1).max(2_000).optional(),
  corrected_structured_requirement: z.record(z.string(), z.unknown()).optional(),
  unit_context: z.string().trim().max(100).nullable().optional(),
  rationale: z.string().trim().max(1_000).nullable().optional(),
  acknowledge_exclusion: z.boolean().optional(),
  learning_proposal: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("alias"), scope: z.enum(["exact_phrase", "one_base_item"]), base_item_id: z.number().int().positive(), alias: z.string().trim().min(1).max(250) }),
    z.object({ kind: z.literal("metadata"), scope: z.literal("one_base_item"), base_item_id: z.number().int().positive(), attribute_type: z.enum(["flower_type", "color", "stem_length_cm", "container_type", "shape", "material", "height_cm", "width_cm", "diameter_cm", "package_count", "preferred_canonical_product_format"]), proposed_value: z.unknown(), source_text: z.string().trim().max(1_000).nullable().optional() }),
    z.object({ kind: z.literal("contextual_rule"), scope: z.enum(["exact_phrase", "ingredient_color_combination", "canonical_product_format", "dimension_pattern", "workspace_wide_rule"]), name: z.string().trim().min(1).max(200), description: z.string().trim().max(2_000).nullable().optional(), definition: z.record(z.string(), z.unknown()), specificity: z.number().int().min(0).max(1_000).default(0), priority: z.number().int().min(-1_000).max(1_000).default(0) }),
  ]).optional(),
}).superRefine((value, context) => {
  if (value.correction_type !== "add_line" && value.line_id == null) context.addIssue({ code: "custom", message: "line_id is required" });
  if (["replace_base_item", "add_line"].includes(value.correction_type) && value.base_item_id == null) context.addIssue({ code: "custom", message: "base_item_id is required" });
  if (value.correction_type === "change_quantity" && value.quantity == null) context.addIssue({ code: "custom", message: "quantity is required" });
  if (value.correction_type === "preserve_unresolved" && value.acknowledge_exclusion !== true) context.addIssue({ code: "custom", message: "Exclusion requires acknowledgement" });
  if (value.intent === "propose_learning" && !value.learning_proposal) context.addIssue({ code: "custom", message: "Learning proposal is required" });
  if (value.correction_type === "add_line" && value.corrected_structured_requirement?.kind !== undefined
    && !["ingredient", "container", "component"].includes(String(value.corrected_structured_requirement.kind))) {
    context.addIssue({ code: "custom", message: "Reviewer requirement kind is invalid" });
  }
  if (value.correction_type === "add_line" && value.corrected_structured_requirement?.subtype !== undefined) {
    const kind = value.corrected_structured_requirement.kind;
    if (typeof kind !== "string" || !["ingredient", "container", "component"].includes(kind)
      || !isSupportedRecipeRequirementSubtype(kind as RecipeRequirement["kind"], value.corrected_structured_requirement.subtype)) {
      context.addIssue({ code: "custom", message: "Reviewer requirement subtype does not match its kind" });
    }
  }
  const proposal = value.learning_proposal;
  if (proposal?.kind === "contextual_rule") {
    const d = proposal.definition; const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;
    if (proposal.scope === "exact_phrase" && !text(d.phrase)) context.addIssue({ code: "custom", message: "Exact-phrase rules require a phrase condition" });
    if (proposal.scope === "ingredient_color_combination" && (!text(d.ingredient) || !text(d.color))) context.addIssue({ code: "custom", message: "Ingredient/color rules require both conditions" });
    if (proposal.scope === "canonical_product_format" && !text(d.canonical_product_format)) context.addIssue({ code: "custom", message: "Canonical-format rules require a canonical Product-format condition" });
    if (proposal.scope === "dimension_pattern" && (!d.dimensions || typeof d.dimensions !== "object" || Array.isArray(d.dimensions) || !Object.keys(d.dimensions as object).length)) context.addIssue({ code: "custom", message: "Dimension-pattern rules require dimensions" });
    if (proposal.scope === "workspace_wide_rule" && d.workspace_wide !== true) context.addIssue({ code: "custom", message: "Workspace-wide rules must be explicit" });
  }
});

function lineRequirement(line: StoredLine | null, suggestion: StoredSuggestion): RecipeRequirement | null {
  const evidence = Array.isArray(line?.source_evidence) ? line.source_evidence : [];
  const linked = evidence.find((entry) => entry && typeof entry === "object"
    && typeof (entry as { requirement_id?: unknown }).requirement_id === "string") as
    { requirement_id: string; requirement_provenance?: RecipeRequirement } | undefined;
  if (!linked) return null;
  if (linked.requirement_provenance?.requirementId === linked.requirement_id
    && ["ingredient", "container", "component"].includes(linked.requirement_provenance.kind)
    && (linked.requirement_provenance.subtype == null
      || isSupportedRecipeRequirementSubtype(linked.requirement_provenance.kind, linked.requirement_provenance.subtype))) {
    return linked.requirement_provenance;
  }
  const generated = suggestion.generation_context?.structured_requirements;
  return Array.isArray(generated)
    ? (generated as RecipeRequirement[]).find(({ requirementId }) => requirementId === linked.requirement_id) ?? null
    : null;
}

function compatibilityState(requirement: RecipeRequirement, item: RecipeLineInput): "compatible" | "incompatible" | "unknown" {
  const diagnostic = evaluateCandidateCompatibility(requirement, item);
  if (!diagnostic.survivor || diagnostic.hardExclusions.length > 0) return "incompatible";
  return diagnostic.hasUnknownExplicitDiscriminator ? "unknown" : "compatible";
}

router.post("/products/:id/recipe-suggestions", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!requireProductManagement(wreq, res)) return;
  const productId = parseId(req.params.id);
  if (!productId) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const targetResult = await db.query<ProductRow>(
    `SELECT p.id, p.name, p.description, p.description_ar, p.main_image_url, p.additional_image_urls, p.recipe_version,
            p.tags, p.category
       FROM products p
      WHERE p.id = $1 AND p.workspace_owner_id = $2`,
    [productId, wreq.workspaceOwnerId],
  );
  const targetRow = targetResult.rows[0];
  if (!targetRow) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  await ensureDeterministicRecipeRules(wreq.workspaceOwnerId);
  const runtime = await loadRecipeGenerationRuntime(db, wreq.workspaceOwnerId);
  const runtimeCase = runtime.runForTarget(productId);
  if (!runtimeCase) {
    res.status(409).json({ error: "Product could not be assembled for deterministic Recipe generation" });
    return;
  }
  const {
    target,
    approvedRecipe: existingLiveRecipe,
    supportingProducts,
    matcherRun,
  } = runtimeCase;
  const baseItems = runtime.baseItems;
  const baseItemsResult = { rows: runtime.baseItemRows };
  const rulesResult = { rows: runtime.ruleRows as RuleRow[] };
  const generated = matcherRun.suggestion;
  const candidateIds = new Set(
    generated.unresolvedRequirements.flatMap((requirement) => requirement.candidateBaseItemIds ?? []),
  );
  const aiRequirements = generated.unresolvedRequirements.filter(
    (requirement) => requirement.candidateBaseItemIds && requirement.candidateBaseItemIds.length > 0,
  );
  const aiBaseItems = baseItemsResult.rows.filter((item) => candidateIds.has(item.id));
  const ai = await boundedAiAssistance(
    target,
    aiBaseItems,
    aiRequirements,
    wreq.workspaceOwnerId,
  );
  const lines = toDraftLines(generated, baseItemsResult.rows, rulesResult.rows, ai.lines);
  const userId = wreq.userId ?? null;
  const context = {
    target_product: target,
    product_images: {
      main_image_url: targetRow.main_image_url,
      additional_image_urls: targetRow.additional_image_urls ?? [],
      image_used_for_ai: false,
    },
    existing_live_recipe: existingLiveRecipe,
    live_recipe_version: Number(targetRow.recipe_version ?? 0),
    active_rules: rulesResult.rows,
    structured_requirements: generated.requirements,
    candidate_metadata: baseItemsResult.rows.map((item) => ({
      base_item_id: item.id,
      approved_metadata: item.approved_metadata ?? {},
      approved_aliases: item.approved_aliases ?? [],
      unapproved_candidates: item.candidate_metadata ?? [],
    })),
    version_manifest: {
      engine: RECIPE_SUGGESTION_ENGINE_VERSION,
      rules: RECIPE_SUGGESTION_RULESET_VERSION,
      aliases: RECIPE_SUGGESTION_ALIAS_VERSION,
      metadata: RECIPE_SUGGESTION_METADATA_VERSION,
      prompt: RECIPE_SUGGESTION_PROMPT_VERSION,
      model: process.env.RECIPE_SUGGESTION_MODEL ?? "gpt-4o-mini",
      configuration_fingerprint: matcherRun.configurationFingerprint,
      case_input_fingerprint: matcherRun.caseInputFingerprint,
    },
    deterministic_matcher: {
      configuration_fingerprint: matcherRun.configurationFingerprint,
      case_input_fingerprint: matcherRun.caseInputFingerprint,
      configuration_snapshot: matcherRun.configurationSnapshot,
      case_input_snapshot: matcherRun.caseInputSnapshot,
    },
    engine: generated,
    ai: {
      outcome: ai.outcome,
      executed: !["not_needed", "unavailable"].includes(ai.outcome),
      bounded_to_supplied_base_items: true,
      policy: matcherRun.configurationSnapshot.boundedAi,
    },
    suggested_lines: lines,
  };

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // The lock serializes per-product version assignment and ensures no
    // generated request can silently win a race against an approval.
    const productLock = await client.query<{ id: number; recipe_version: number }>(
      `SELECT id, recipe_version
         FROM products
        WHERE id = $1 AND workspace_owner_id = $2
        FOR UPDATE`,
      [productId, wreq.workspaceOwnerId],
    );
    const generatedFromLiveRecipeVersion = Number(productLock.rows[0]?.recipe_version ?? 0);
    const generationContext = {
      ...context,
      live_recipe_version: generatedFromLiveRecipeVersion,
    };
    const superseded = await client.query<{ id: number }>(
      `UPDATE recipe_suggestions
          SET status = 'superseded'
        WHERE product_id = $1 AND workspace_owner_id = $2
          AND status IN ('draft', 'generated', 'under_review')
        RETURNING id`,
      [productId, wreq.workspaceOwnerId],
    );
    for (const prior of superseded.rows) {
      await client.query(
        `INSERT INTO recipe_suggestion_actions (
           workspace_owner_id, suggestion_id, action, actor_user_id, context
         ) VALUES ($1, $2, 'superseded', $3, $4::jsonb)`,
        [wreq.workspaceOwnerId, prior.id, userId, JSON.stringify({ superseded_by_generation: true })],
      );
    }
    const versionResult = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM recipe_suggestions
        WHERE product_id = $1 AND workspace_owner_id = $2`,
      [productId, wreq.workspaceOwnerId],
    );
    const insertResult = await client.query<{ id: number }>(
      `INSERT INTO recipe_suggestions (
         workspace_owner_id, product_id, version, version_manifest, status, generation_context,
         confidence, rationale, created_by_user_id
       ) VALUES ($1, $2, $3, $4::jsonb, 'generated', $5::jsonb, $6, $7, $8)
       RETURNING id`,
      [
        wreq.workspaceOwnerId,
        productId,
        versionResult.rows[0].version,
        JSON.stringify(context.version_manifest),
        JSON.stringify(generationContext),
        lines.length === 0 ? 0 : lines.reduce((total, line) => total + confidenceScore[line.confidence], 0) / lines.length,
        "Reviewable draft generated from deterministic evidence; never published automatically.",
        userId,
      ],
    );
    const suggestionId = insertResult.rows[0].id;
    await insertDraftLines(client, wreq.workspaceOwnerId, suggestionId, lines);
    await client.query(
      `INSERT INTO recipe_suggestion_actions (
         workspace_owner_id, suggestion_id, action, actor_user_id, context
       ) VALUES ($1, $2, 'generated', $3, $4::jsonb)`,
      [wreq.workspaceOwnerId, suggestionId, userId, JSON.stringify({
        engine_version: generated.engineVersion,
        rule_set_version: generated.ruleSetVersion,
        alias_version: RECIPE_SUGGESTION_ALIAS_VERSION,
        metadata_version: RECIPE_SUGGESTION_METADATA_VERSION,
        prompt_version: RECIPE_SUGGESTION_PROMPT_VERSION,
         configuration_fingerprint: matcherRun.configurationFingerprint,
         case_input_fingerprint: matcherRun.caseInputFingerprint,
        similar_products: generated.similarProducts,
        conflicts: generated.conflicts,
        unresolved_lines: generated.unresolvedLines,
        ai_outcome: ai.outcome,
         bounded_ai_executed: !["not_needed", "unavailable"].includes(ai.outcome),
      })],
    );
    await client.query("COMMIT");
    const detail = await suggestionDetail(suggestionId, wreq.workspaceOwnerId);
    res.status(201).json({
      suggestion: detail?.suggestion,
      lines: detail?.lines.map(serializeLine),
      actions: detail?.actions,
      live_recipe: existingLiveRecipe,
      live_recipe_version: generatedFromLiveRecipeVersion,
      live_recipe_changed: false,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

router.get("/products/:id/recipe-suggestions", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!requireProductManagement(wreq, res)) return;
  const productId = parseId(req.params.id);
  if (!productId) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }
  const result = await db.query<StoredSuggestion>(
    `SELECT id, workspace_owner_id, product_id, version, version_manifest, status, generation_context,
            confidence, rationale, created_by_user_id, created_at
       FROM recipe_suggestions
      WHERE product_id = $1 AND workspace_owner_id = $2
      ORDER BY version DESC`,
    [productId, wreq.workspaceOwnerId],
  );
  res.json({ suggestions: result.rows });
});

router.get("/recipe-suggestions/:id", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!requireProductManagement(wreq, res)) return;
  const suggestionId = parseId(req.params.id);
  if (!suggestionId) {
    res.status(400).json({ error: "Invalid recipe suggestion id" });
    return;
  }
  const detail = await suggestionDetail(suggestionId, wreq.workspaceOwnerId);
  if (!detail) {
    res.status(404).json({ error: "Recipe suggestion not found" });
    return;
  }
  res.json({
    suggestion: detail.suggestion,
    lines: detail.lines.map(serializeLine),
    actions: detail.actions,
    corrections: detail.corrections,
    original_lines: Array.isArray(detail.suggestion.generation_context?.suggested_lines)
      ? detail.suggestion.generation_context.suggested_lines : [],
    live_recipe: detail.liveRecipe.map(recipeLine),
    live_recipe_version: detail.liveRecipeVersion,
    structured_requirements: detail.suggestion.generation_context?.structured_requirements ?? {},
  });
});

router.post("/recipe-suggestions/:id/corrections", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!requireProductManagement(wreq, res)) return;
  const suggestionId = parseId(req.params.id);
  const parsed = correctionSchema.safeParse(req.body);
  if (!suggestionId || !parsed.success) {
    res.status(400).json({ error: !suggestionId ? "Invalid recipe suggestion id" : "Invalid recipe correction", ...(!parsed.success ? { details: parsed.error.issues } : {}) });
    return;
  }
  const input = parsed.data;
  const structuredQuantity = input.correction_type === "correct_requirement"
    ? input.corrected_structured_requirement?.quantity : undefined;
  const correctedRequirementQuantity = structuredQuantity === undefined ? undefined : Number(structuredQuantity);
  if (structuredQuantity !== undefined
    && (!Number.isFinite(correctedRequirementQuantity ?? NaN) || (correctedRequirementQuantity ?? 0) <= 0)) {
    res.status(400).json({ error: "Corrected requirement quantity must be a positive number" });
    return;
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<StoredSuggestion>(
      `SELECT id, workspace_owner_id, product_id, version, version_manifest, status, generation_context,
              confidence, rationale, created_by_user_id, created_at FROM recipe_suggestions
        WHERE id = $1 AND workspace_owner_id = $2 FOR UPDATE`, [suggestionId, wreq.workspaceOwnerId]);
    const suggestion = locked.rows[0];
    if (!suggestion || suggestion.product_id == null) {
      await client.query("ROLLBACK"); res.status(404).json({ error: "Recipe suggestion not found" }); return;
    }
    if (!["draft", "generated", "under_review"].includes(suggestion.status)) {
      await client.query("ROLLBACK"); res.status(409).json({ error: "This recipe suggestion is no longer editable" }); return;
    }
    const lineResult = input.line_id == null ? { rows: [] as StoredLine[] } : await client.query<StoredLine>(
      `SELECT id, line_order, proposed_base_item_id, proposed_base_item_name, proposed_base_item_code,
              extracted_requirement, unit_context, source_evidence, match_confidence, quantity, confidence,
              source_type, source_rule_id, rationale, resolution_status, exclusion_reason, exclusion_acknowledged, created_at
         FROM recipe_suggestion_lines WHERE id = $1 AND suggestion_id = $2 AND workspace_owner_id = $3 FOR UPDATE`,
      [input.line_id, suggestionId, wreq.workspaceOwnerId]);
    const original = lineResult.rows[0] ?? null;
    if (input.correction_type !== "add_line" && !original) {
      await client.query("ROLLBACK"); res.status(404).json({ error: "Recipe suggestion line not found" }); return;
    }
    if (input.intent === "propose_learning" && input.learning_proposal?.kind === "contextual_rule") {
      const semanticEvidence = Array.isArray(original?.source_evidence) ? original!.source_evidence : [];
      const semantic = semanticEvidence.find((entry) => entry && typeof entry === "object"
        && typeof (entry as { requirement_id?: unknown }).requirement_id === "string"
        && (entry as { requirement_provenance?: unknown }).requirement_provenance) as { requirement_id: string } | undefined;
      const formatResolution = (suggestion.generation_context?.engine as { structure?: { formatResolution?: { authoritativePrimaryFormat?: unknown } } } | undefined)
        ?.structure?.formatResolution;
      const authoritativeFormat = formatResolution?.authoritativePrimaryFormat;
      if (!semantic || typeof authoritativeFormat !== "string" || authoritativeFormat === "Unknown") {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Contextual learning requires a resolved semantic requirement and an authoritative primary format" });
        return;
      }
    }
    let item: BaseItemRow | null = null;
    if (input.base_item_id != null) {
      const items = await client.query<BaseItemRow>(
        `SELECT bi.id, bi.name, bi.code, COALESCE(bip.unit, 'unit') AS canonical_unit, bip.name AS package_name,
                bip.quantity AS package_quantity,
                COALESCE((SELECT jsonb_object_agg(m.attribute_type,m.proposed_value)
                  FROM base_item_metadata_candidates m WHERE m.workspace_owner_id=bi.workspace_owner_id
                    AND m.base_item_id=bi.id AND m.status='approved'),'{}'::jsonb) AS approved_metadata,
                '[]'::jsonb AS candidate_metadata,
                COALESCE((SELECT jsonb_agg(a.alias ORDER BY a.id) FROM base_item_aliases a
                  WHERE a.workspace_owner_id=bi.workspace_owner_id AND a.base_item_id=bi.id
                    AND a.status='approved'),'[]'::jsonb) AS approved_aliases
           FROM base_items bi LEFT JOIN base_item_packages bip ON bip.base_item_id = bi.id AND bip.workspace_owner_id = bi.workspace_owner_id AND bip.is_default = true
          WHERE bi.id = $1 AND bi.workspace_owner_id = $2 AND COALESCE(bi.status, 'active') = 'active' AND bi.archived_at IS NULL`,
        [input.base_item_id, wreq.workspaceOwnerId]);
      item = items.rows[0] ?? null;
      if (!item) { await client.query("ROLLBACK"); res.status(400).json({ error: "The selected Base Item is unavailable in this workspace" }); return; }
    }
    const evidence = Array.isArray(original?.source_evidence) ? original!.source_evidence : [];
    const addLineOrder = input.correction_type === "add_line"
      ? await client.query<{ line_order: number }>(`SELECT COALESCE(MAX(line_order), -1) + 1 AS line_order FROM recipe_suggestion_lines WHERE suggestion_id = $1 AND workspace_owner_id = $2`, [suggestionId, wreq.workspaceOwnerId])
      : null;
    const reviewerRequirementId = `reviewer:${suggestionId}:${Number(addLineOrder?.rows[0]?.line_order ?? input.line_id ?? 0)}`;
    const reviewerPhrase = input.extracted_requirement ?? item?.name ?? "Reviewer requirement";
    const explicitKind = input.corrected_structured_requirement?.kind as RecipeRequirement["kind"] | undefined;
    const derivedRequirements = input.correction_type === "add_line" && !explicitKind
      ? extractRecipeRequirements({ name: reviewerPhrase, description: null, descriptionAr: null, category: null, tags: [] })
      : [];
    const classified = explicitKind
      ? { kind: explicitKind, subtype: input.corrected_structured_requirement?.subtype as string | undefined }
      : derivedRequirements.length === 1
        ? { kind: derivedRequirements[0].kind, subtype: derivedRequirements[0].subtype ?? undefined }
        : null;
    const requirement = input.correction_type === "add_line"
      ? classified ? { requirementId: reviewerRequirementId, kind: classified.kind, subtype: classified.subtype,
          phrase: reviewerPhrase,
          quantity: input.quantity ?? 1, unit: input.unit_context ?? item?.canonical_unit ?? null,
          attributes: input.corrected_structured_requirement?.attributes
            && typeof input.corrected_structured_requirement.attributes === "object"
            && !Array.isArray(input.corrected_structured_requirement.attributes)
            ? input.corrected_structured_requirement.attributes as Record<string, unknown> : {},
          candidateBaseItemIds: item ? [item.id] : [], resolution: "ambiguous" as const,
          evidence: { sourceField: "name" as const, sourceIndex: 0, lineIndex: 0, componentIndex: 0, occurrence: 0,
            exactPhrase: reviewerPhrase, normalizedPhrase: reviewerPhrase.toLowerCase(),
            span: { start: 0, end: reviewerPhrase.length } },
          similarEvidence: [] }
        : null
      : lineRequirement(original, suggestion);
    const currentCompatibility = requirement && item ? compatibilityState(requirement, {
      baseItemId: item.id, baseItemName: item.name, baseItemCode: item.code, quantity: requirement.quantity,
      metadata: { ...(item.approved_metadata ?? {}), approved: true,
        approvedAliases: item.approved_aliases ?? [], governedPackageFacts: item.package_quantity != null,
        packageName: item.package_name, packageSize: item.package_quantity == null ? undefined : Number(item.package_quantity) },
    }) : "unknown";
    if (["replace_base_item", "add_line"].includes(input.correction_type) && currentCompatibility === "incompatible") {
      await client.query("ROLLBACK"); res.status(422).json({ error: "Selected Base Item is incompatible with this requirement" }); return;
    }
    const unknownCompatibility = !!item && currentCompatibility === "unknown";
    const persistedRequirement = input.correction_type === "add_line" && requirement
      ? { ...requirement, resolution: unknownCompatibility ? "ambiguous" as const : "matched" as const }
      : requirement;
    const reviewerDraftProvenance = persistedRequirement ?? {
      requirementId: reviewerRequirementId, semanticKindStatus: "unresolved",
      phrase: reviewerPhrase, quantity: input.quantity ?? 1,
      unit: input.unit_context ?? item?.canonical_unit ?? null,
      attributes: input.corrected_structured_requirement?.attributes ?? {},
      resolution: "ambiguous",
      reviewerProvenance: { actorUserId: wreq.userId ?? null },
    };
    const originalSnapshot = original ? serializeLine(original) : {};
    let corrected: StoredLine;
    if (input.correction_type === "add_line") {
      const requirementId = reviewerRequirementId;
      const inserted = await client.query<StoredLine>(
        `INSERT INTO recipe_suggestion_lines (workspace_owner_id, suggestion_id, line_order, proposed_base_item_id, proposed_base_item_name, proposed_base_item_code, extracted_requirement, unit_context, source_evidence, match_confidence, quantity, confidence, source_type, rationale, resolution_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,'reviewer_correction',$13,$14) RETURNING *`,
        [wreq.workspaceOwnerId, suggestionId, Number(addLineOrder!.rows[0]?.line_order ?? 0), item!.id, item!.name, item!.code, reviewerDraftProvenance.phrase, reviewerDraftProvenance.unit, JSON.stringify([{ type: "reviewer_added_requirement", requirement_id: requirementId, requirement_provenance: reviewerDraftProvenance, actor_user_id: wreq.userId ?? null }]), unknownCompatibility ? "low" : "high", reviewerDraftProvenance.quantity, unknownCompatibility ? .4 : .95, input.rationale ?? "Reviewer-added requirement", unknownCompatibility ? "unresolved" : "resolved"]);
      corrected = inserted.rows[0];
    } else if (input.correction_type === "remove_line") {
      // Preserve identity/history; removal is an explicit exclusion, never deletion.
      const updated = await client.query<StoredLine>(`UPDATE recipe_suggestion_lines SET resolution_status = 'excluded', exclusion_acknowledged = true, exclusion_reason = $4 WHERE id=$1 AND suggestion_id=$2 AND workspace_owner_id=$3 RETURNING *`, [original!.id, suggestionId, wreq.workspaceOwnerId, input.note ?? input.reason]);
      corrected = updated.rows[0];
    } else {
      const selected = input.correction_type === "replace_base_item" ? item : original!.proposed_base_item_id == null ? null : { id: original!.proposed_base_item_id, name: original!.proposed_base_item_name, code: original!.proposed_base_item_code, canonical_unit: original!.unit_context };
      const excluded = input.correction_type === "preserve_unresolved";
      const updated = await client.query<StoredLine>(
        `UPDATE recipe_suggestion_lines SET proposed_base_item_id=$4, proposed_base_item_name=$5, proposed_base_item_code=$6, extracted_requirement=$7, unit_context=$8, quantity=$9, match_confidence=$10, confidence=$11, source_type='reviewer_correction', rationale=$12, resolution_status=$13, exclusion_reason=$14, exclusion_acknowledged=$15 WHERE id=$1 AND suggestion_id=$2 AND workspace_owner_id=$3 RETURNING *`,
        [original!.id, suggestionId, wreq.workspaceOwnerId, excluded ? null : selected?.id ?? null, excluded ? null : selected?.name ?? null, excluded ? null : selected?.code ?? null, input.extracted_requirement ?? original!.extracted_requirement, input.unit_context ?? selected?.canonical_unit ?? original!.unit_context, input.quantity ?? correctedRequirementQuantity ?? Number(original!.quantity), excluded ? "no_match" : unknownCompatibility ? "low" : "high", excluded ? 0 : unknownCompatibility ? .4 : .95, input.rationale ?? "Recipe draft corrected by reviewer.", excluded ? "excluded" : unknownCompatibility || !selected ? "unresolved" : "resolved", excluded ? (input.note ?? input.reason) : null, excluded]);
      corrected = updated.rows[0];
    }
    let candidateRuleId: number | null = null;
    let candidateAliasId: number | null = null;
    let candidateMetadataId: number | null = null;
    if (input.intent === "propose_learning" && input.learning_proposal?.kind === "alias") {
      const proposal = input.learning_proposal;
      const created = await client.query<{ id: number }>(
        `INSERT INTO base_item_aliases (workspace_owner_id,base_item_id,alias,normalized_alias,source_type,source_actor_user_id,status)
         VALUES ($1,$2,$3,$4,'actor',$5,'candidate') ON CONFLICT (workspace_owner_id,normalized_alias) DO NOTHING RETURNING id`,
        [wreq.workspaceOwnerId, proposal.base_item_id, proposal.alias, proposal.alias.trim().toLocaleLowerCase(), wreq.userId ?? null]);
      candidateAliasId = created.rows[0]?.id ?? null;
      if (candidateAliasId != null) await client.query(
        `INSERT INTO base_item_alias_decisions (workspace_owner_id,alias_id,action,actor_user_id,previous_state,next_state,note)
         VALUES ($1,$2,'created',$3,'{}'::jsonb,$4::jsonb,$5)`,
        [wreq.workspaceOwnerId, candidateAliasId, wreq.userId ?? null, JSON.stringify({ status: "candidate", scope: proposal.scope }), input.note ?? null]);
    }
    if (input.intent === "propose_learning" && input.learning_proposal?.kind === "metadata") {
      const proposal = input.learning_proposal;
      const created = await client.query<{ id: number }>(
        `INSERT INTO base_item_metadata_candidates (workspace_owner_id,base_item_id,attribute_type,proposed_value,source_text,extraction_method,confidence,source_type,source_actor_user_id,status)
         VALUES ($1,$2,$3,$4::jsonb,$5,'recipe_correction',1,'actor',$6,'candidate') RETURNING id`,
        [wreq.workspaceOwnerId, proposal.base_item_id, proposal.attribute_type, JSON.stringify(proposal.proposed_value), proposal.source_text ?? corrected.extracted_requirement, wreq.userId ?? null]);
      candidateMetadataId = created.rows[0]?.id ?? null;
      if (candidateMetadataId != null) await client.query(
        `INSERT INTO base_item_metadata_candidate_decisions (workspace_owner_id,candidate_id,action,actor_user_id,previous_state,next_state,note)
         VALUES ($1,$2,'created',$3,'{}'::jsonb,$4::jsonb,$5)`,
        [wreq.workspaceOwnerId, candidateMetadataId, wreq.userId ?? null, JSON.stringify({ status: "candidate", scope: proposal.scope }), input.note ?? null]);
    }
    if (input.intent === "propose_learning" && input.learning_proposal?.kind === "contextual_rule") {
      const authoritativeFormat = ((suggestion.generation_context?.engine as { structure?: { formatResolution?: { authoritativePrimaryFormat?: string } } } | undefined)
        ?.structure?.formatResolution?.authoritativePrimaryFormat)!;
      const proposal = input.learning_proposal;
      const created = await client.query<{ id: number }>(
        `INSERT INTO recipe_rules (workspace_owner_id,rule_key,name,rule_type,source,status,definition,confidence,created_by_user_id)
         VALUES ($1,$2,$3,'contextual_resolution','manual','candidate',$4::jsonb,1,$5) RETURNING id`,
        [wreq.workspaceOwnerId, `correction-${suggestionId}-${corrected.id}-${proposal.scope}`,
          proposal.name ?? "Reviewer contextual correction",
          JSON.stringify({ ...(proposal.definition ?? {}), proposed_scope: proposal.scope,
            resolver_base_item_id: corrected.proposed_base_item_id, canonical_formats: [authoritativeFormat] }),
          wreq.userId ?? null],
      );
      candidateRuleId = created.rows[0]?.id ?? null;
      if (candidateRuleId != null) await client.query(
        `INSERT INTO recipe_rule_actions (workspace_owner_id,rule_id,action,actor_user_id,previous_state,next_state,note)
         VALUES ($1,$2,'discovered',$3,'{}'::jsonb,$4::jsonb,$5)`,
        [wreq.workspaceOwnerId, candidateRuleId, wreq.userId ?? null,
          JSON.stringify({ status: "candidate", scope: proposal.scope }), input.note ?? null],
      );
    }
    const originalStructured = requirement ?? {};
    const correctedStructured = input.corrected_structured_requirement
      ? {
          ...originalStructured,
          ...input.corrected_structured_requirement,
          requirementId: requirement?.requirementId,
          quantity: correctedRequirementQuantity ?? requirement?.quantity,
          attributes: {
            ...(requirement?.attributes ?? {}),
            ...((input.corrected_structured_requirement.attributes
              && typeof input.corrected_structured_requirement.attributes === "object"
              && !Array.isArray(input.corrected_structured_requirement.attributes))
              ? input.corrected_structured_requirement.attributes as Record<string, unknown> : {}),
          },
          evidence: input.corrected_structured_requirement.phrase !== undefined
            ? { sourceField: "name", sourceIndex: 0, lineIndex: 0, componentIndex: 0, occurrence: 0,
                exactPhrase: String(input.corrected_structured_requirement.phrase),
                normalizedPhrase: String(input.corrected_structured_requirement.phrase).toLowerCase(),
                span: { start: 0, end: String(input.corrected_structured_requirement.phrase).length },
                provenance: "reviewer_correction", actorUserId: wreq.userId ?? null }
            : requirement?.evidence,
          invalidatedExtractionAttributes: input.corrected_structured_requirement.attributes
            && typeof input.corrected_structured_requirement.attributes === "object"
            ? Object.keys(input.corrected_structured_requirement.attributes as Record<string, unknown>) : [],
          reviewerAttributeEvidence: input.corrected_structured_requirement.attributes
            && typeof input.corrected_structured_requirement.attributes === "object"
            ? Object.entries(input.corrected_structured_requirement.attributes as Record<string, unknown>)
              .map(([attribute, value]) => ({
                type: "reviewer_correction",
                attribute: `attributes.${attribute}`,
                value,
                actorUserId: wreq.userId ?? null,
              })) : [],
          reviewerCorrectionProvenance: {
            actorUserId: wreq.userId ?? null,
            changedFields: [
              ...Object.keys(input.corrected_structured_requirement).filter((key) => key !== "attributes"),
              ...(input.corrected_structured_requirement.attributes
                && typeof input.corrected_structured_requirement.attributes === "object"
                ? Object.keys(input.corrected_structured_requirement.attributes as Record<string, unknown>)
                  .map((key) => `attributes.${key}`) : []),
            ],
            changedAttributes: input.corrected_structured_requirement.attributes
              && typeof input.corrected_structured_requirement.attributes === "object"
              ? Object.keys(input.corrected_structured_requirement.attributes as Record<string, unknown>) : [],
            correctedValues: input.corrected_structured_requirement.attributes
              && typeof input.corrected_structured_requirement.attributes === "object"
              ? input.corrected_structured_requirement.attributes : {},
          },
        }
      : originalStructured;
    // The line is the authoritative link to its semantic requirement. Persist
    // the corrected provenance in-place so later corrections and approval do
    // not read stale generation-time evidence; unrelated evidence is retained.
    if (input.correction_type === "correct_requirement" && requirement) {
      const correctedEvidence = evidence.map((entry) => entry && typeof entry === "object"
        && (entry as { requirement_id?: unknown }).requirement_id === requirement.requirementId
        ? { ...(entry as Record<string, unknown>), requirement_provenance: correctedStructured }
        : entry);
      const evidenceResult = await client.query<StoredLine>(
        `UPDATE recipe_suggestion_lines SET source_evidence=$4::jsonb
          WHERE id=$1 AND suggestion_id=$2 AND workspace_owner_id=$3 RETURNING *`,
        [corrected.id, suggestionId, wreq.workspaceOwnerId, JSON.stringify(correctedEvidence)],
      );
      corrected = evidenceResult.rows[0] ?? { ...corrected, source_evidence: correctedEvidence };
    }
    const correction = await client.query(
      `INSERT INTO recipe_suggestion_corrections (workspace_owner_id,suggestion_id,line_id,correction_type,extraction_error_type,original_structured_requirement,corrected_structured_requirement,original_line,corrected_line,product_context,format_context,reason,note,actor_user_id,intent,proposed_scope,candidate_alias_id,candidate_rule_id,candidate_metadata_id,before_evidence,after_evidence)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb) RETURNING *`,
      [wreq.workspaceOwnerId,suggestionId,corrected.id,input.correction_type,input.extraction_error_type ?? null,JSON.stringify(originalStructured),JSON.stringify(correctedStructured),JSON.stringify(originalSnapshot),JSON.stringify(serializeLine(corrected)),JSON.stringify(suggestion.generation_context?.target_product ?? {}),JSON.stringify((suggestion.generation_context?.engine as { structure?: { formatResolution?: unknown } } | undefined)?.structure?.formatResolution ?? {}),input.reason,input.note ?? null,wreq.userId ?? null,input.intent,input.learning_proposal?.scope ?? null,candidateAliasId,candidateRuleId,candidateMetadataId,JSON.stringify(evidence),JSON.stringify(Array.isArray(corrected.source_evidence) ? corrected.source_evidence : [])]);
    await client.query(`UPDATE recipe_suggestions SET status='under_review' WHERE id=$1 AND workspace_owner_id=$2`, [suggestionId,wreq.workspaceOwnerId]);
    await client.query(`INSERT INTO recipe_suggestion_actions (workspace_owner_id,suggestion_id,action,actor_user_id,note,context) VALUES ($1,$2,'corrected',$3,$4,$5::jsonb)`, [wreq.workspaceOwnerId,suggestionId,wreq.userId ?? null,input.note ?? null,JSON.stringify({ correction_id: correction.rows[0]?.id, correction_type: input.correction_type })]);
    await client.query("COMMIT");
    res.status(201).json({ correction: correction.rows[0], live_recipe_changed: false, learning_activated: false });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
});

router.patch("/recipe-suggestions/:id", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!requireProductManagement(wreq, res)) return;
  res.status(410).json({
    error: "Bulk recipe suggestion edits are no longer supported; use line-level /recipe-suggestions/:id/corrections",
    code: "LINE_LEVEL_CORRECTIONS_REQUIRED",
  });
});

router.post("/recipe-suggestions/:id/reject", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!requireProductManagement(wreq, res)) return;
  const suggestionId = parseId(req.params.id);
  if (!suggestionId) {
    res.status(400).json({ error: "Invalid recipe suggestion id" });
    return;
  }
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid rejection note", details: parsed.error.issues });
    return;
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<StoredSuggestion>(
      `UPDATE recipe_suggestions
          SET status = 'rejected'
        WHERE id = $1 AND workspace_owner_id = $2
          AND status IN ('draft', 'generated', 'under_review')
        RETURNING id, workspace_owner_id, product_id, version, status, generation_context,
                  confidence, rationale, created_by_user_id, created_at`,
      [suggestionId, wreq.workspaceOwnerId],
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Recipe suggestion cannot be rejected in its current state" });
      return;
    }
    await client.query(
      `INSERT INTO recipe_suggestion_actions (
         workspace_owner_id, suggestion_id, action, actor_user_id, note, context
       ) VALUES ($1, $2, 'rejected', $3, $4, $5::jsonb)`,
      [wreq.workspaceOwnerId, suggestionId, wreq.userId ?? null, parsed.data.note ?? null, JSON.stringify({
        status: "rejected",
        generated_lines: result.rows[0].generation_context?.suggested_lines ?? [],
      })],
    );
    await client.query("COMMIT");
    res.json({ suggestion: result.rows[0], live_recipe_changed: false });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

router.post("/recipe-suggestions/:id/approve", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!requireProductManagement(wreq, res)) return;
  const suggestionId = parseId(req.params.id);
  if (!suggestionId) {
    res.status(400).json({ error: "Invalid recipe suggestion id" });
    return;
  }
  const parsed = noteSchema.extend({
    expected_live_recipe_version: z.number().int().min(0),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid approval note", details: parsed.error.issues });
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const lookup = await client.query<StoredSuggestion>(
      `SELECT id, workspace_owner_id, product_id, version, version_manifest, status, generation_context,
              confidence, rationale, created_by_user_id, created_at
         FROM recipe_suggestions
        WHERE id = $1 AND workspace_owner_id = $2`,
      [suggestionId, wreq.workspaceOwnerId],
    );
    if (!lookup.rows[0]?.product_id) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Recipe suggestion not found" });
      return;
    }
    // Product is always locked before the suggestion, matching generation's
    // lock order and preventing a concurrent live replacement from slipping in.
    const liveVersion = await client.query<{ recipe_version: number }>(
      `SELECT recipe_version FROM products WHERE id = $1 AND workspace_owner_id = $2 FOR UPDATE`,
      [lookup.rows[0].product_id, wreq.workspaceOwnerId],
    );
    const suggestionResult = await client.query<StoredSuggestion>(
      `SELECT id, workspace_owner_id, product_id, version, version_manifest, status, generation_context,
              confidence, rationale, created_by_user_id, created_at FROM recipe_suggestions
        WHERE id = $1 AND workspace_owner_id = $2 FOR UPDATE`, [suggestionId, wreq.workspaceOwnerId],
    );
    const suggestion = suggestionResult.rows[0];
    if (!suggestion || !suggestion.product_id) {
      await client.query("ROLLBACK"); res.status(404).json({ error: "Recipe suggestion not found" }); return;
    }
    const storedLiveVersion = suggestion.generation_context?.live_recipe_version;
    if (!Number.isInteger(storedLiveVersion)
      || Number(liveVersion.rows[0]?.recipe_version ?? 0) !== parsed.data.expected_live_recipe_version
      || Number(storedLiveVersion) !== parsed.data.expected_live_recipe_version) {
        const currentLive = await client.query<RecipeRow>(
          `SELECT pr.product_id, pr.base_item_id, bi.name AS base_item_name, bi.code AS base_item_code,
                  pr.quantity::text AS quantity FROM product_recipes pr
             JOIN base_items bi ON bi.id=pr.base_item_id AND bi.workspace_owner_id=pr.workspace_owner_id
            WHERE pr.product_id=$1 AND pr.workspace_owner_id=$2 ORDER BY pr.sort_order ASC, pr.id ASC`,
          [suggestion.product_id, wreq.workspaceOwnerId],
        );
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Live Recipe changed since this suggestion was reviewed", code: "LIVE_RECIPE_VERSION_CONFLICT",
          expected_live_recipe_version: parsed.data.expected_live_recipe_version,
          live_recipe_version: Number(liveVersion.rows[0]?.recipe_version ?? 0),
          live_recipe: currentLive.rows.map(recipeLine) });
        return;
    }
    if (!["draft", "generated", "under_review"].includes(suggestion.status)) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Recipe suggestion cannot be approved in its current state" });
      return;
    }
    const linesResult = await client.query<StoredLine>(
      `SELECT id, line_order, proposed_base_item_id, proposed_base_item_name,
              proposed_base_item_code, extracted_requirement, unit_context,
              source_evidence, match_confidence, quantity, confidence, source_type,
              source_rule_id, rationale, resolution_status, exclusion_reason,
              exclusion_acknowledged, created_at
         FROM recipe_suggestion_lines
        WHERE suggestion_id = $1 AND workspace_owner_id = $2
        ORDER BY line_order ASC, id ASC`,
      [suggestionId, wreq.workspaceOwnerId],
    );
    if (
      linesResult.rows.length === 0
      || linesResult.rows.some((line) =>
        (line.resolution_status !== "excluded" && (
          line.resolution_status !== "resolved" || line.proposed_base_item_id == null
        ))
        || line.source_type === "conflict"
        || (line.resolution_status !== "excluded" && (
          line.source_type === "unresolved" || line.match_confidence === "no_match"
        )),
      )
    ) {
      await client.query("ROLLBACK");
      res.status(422).json({ error: "Resolve every no-match line before approval" });
      return;
    }
    const currentRuntime = await loadRecipeGenerationRuntime(client, wreq.workspaceOwnerId);
    const currentItems = new Map(currentRuntime.baseItems.map((item) => [item.baseItemId, item]));
    const compatibilityFailures: Array<{ line_id: number; requirement_id?: string; state: "unknown" | "incompatible" }> = [];
    for (const line of linesResult.rows) {
      if (line.resolution_status === "excluded") continue;
      const requirement = lineRequirement(line, suggestion);
      const sources = Array.isArray(line.source_evidence) ? line.source_evidence : [];
      const governedHidden = sources.some((entry) => entry && typeof entry === "object"
        && isGovernedOperationalHiddenRuleKey((entry as { hidden_rule_key?: unknown }).hidden_rule_key));
      if (!requirement) {
        if (!governedHidden) compatibilityFailures.push({ line_id: line.id, state: "unknown" });
        continue;
      }
      const item = line.proposed_base_item_id == null ? null : currentItems.get(line.proposed_base_item_id);
      const state = item ? compatibilityState(requirement, item) : "unknown";
      if (state !== "compatible") compatibilityFailures.push({ line_id: line.id, requirement_id: requirement.requirementId, state });
    }
    if (compatibilityFailures.length > 0) {
      await client.query("ROLLBACK");
      res.status(422).json({
        error: "Current governed compatibility requires reviewer resolution before approval",
        code: "RECIPE_COMPATIBILITY_REVIEW_REQUIRED",
        compatibility_failures: compatibilityFailures,
      });
      return;
    }
    const combined = new Map<number, { quantity: number; sortOrder: number }>();
    for (const line of linesResult.rows.filter((candidate) => candidate.resolution_status !== "excluded")) {
      const baseItemId = line.proposed_base_item_id!;
      const quantity = Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Each final recipe item must have a positive quantity" });
        return;
      }
      const previous = combined.get(baseItemId);
      combined.set(baseItemId, {
        quantity: (previous?.quantity ?? 0) + quantity,
        sortOrder: previous?.sortOrder ?? line.line_order,
      });
    }
    const finalItems = [...combined.entries()]
      .map(([baseItemId, item]) => ({ base_item_id: baseItemId, quantity: item.quantity, sort_order: item.sortOrder }))
      .sort((a, b) => a.sort_order - b.sort_order || a.base_item_id - b.base_item_id);
    const baseCheck = await client.query<{ id: number }>(
      `SELECT id FROM base_items
        WHERE id = ANY($1::int[]) AND workspace_owner_id = $2
          AND COALESCE(status, 'active') = 'active' AND archived_at IS NULL`,
      [finalItems.map((item) => item.base_item_id), wreq.workspaceOwnerId],
    );
    if (baseCheck.rows.length !== finalItems.length) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "One or more final Base Items are unavailable in this workspace" });
      return;
    }
    const previousLive = await client.query<RecipeRow>(
      `SELECT pr.product_id, pr.base_item_id, bi.name AS base_item_name, bi.code AS base_item_code,
              pr.quantity::text AS quantity
         FROM product_recipes pr
         JOIN base_items bi ON bi.id = pr.base_item_id AND bi.workspace_owner_id = pr.workspace_owner_id
        WHERE pr.product_id = $1 AND pr.workspace_owner_id = $2
        ORDER BY pr.sort_order ASC, pr.id ASC`,
      [suggestion.product_id, wreq.workspaceOwnerId],
    );
    // Mirrors the existing PUT /products/:id/recipe persistence semantics:
    // replace the approved snapshot, validate ownership, and preserve ordering.
    await client.query(
      `DELETE FROM product_recipes WHERE product_id = $1 AND workspace_owner_id = $2`,
      [suggestion.product_id, wreq.workspaceOwnerId],
    );
    for (const item of finalItems) {
      await client.query(
        `INSERT INTO product_recipes (workspace_owner_id, product_id, base_item_id, quantity, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_id, base_item_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, sort_order = EXCLUDED.sort_order`,
        [wreq.workspaceOwnerId, suggestion.product_id, item.base_item_id, item.quantity, item.sort_order],
      );
    }
    const nextLiveVersion = await client.query<{ recipe_version: number }>(
      `UPDATE products SET recipe_version = COALESCE(recipe_version, 0) + 1
        WHERE id = $1 AND workspace_owner_id = $2 RETURNING recipe_version`,
      [suggestion.product_id, wreq.workspaceOwnerId],
    );
    await client.query(
      `UPDATE recipe_suggestions SET status = 'approved'
        WHERE id = $1 AND workspace_owner_id = $2`,
      [suggestionId, wreq.workspaceOwnerId],
    );
    await client.query(
      `INSERT INTO recipe_suggestion_actions (
         workspace_owner_id, suggestion_id, action, actor_user_id, note, context
       ) VALUES ($1, $2, 'approved', $3, $4, $5::jsonb)`,
      [
        wreq.workspaceOwnerId,
        suggestionId,
        wreq.userId ?? null,
        parsed.data.note ?? null,
        JSON.stringify({
          generated_lines: suggestion.generation_context?.suggested_lines ?? [],
          previous_live_recipe: previousLive.rows.map(recipeLine),
          approved_final_items: finalItems,
          difference_from_suggestion: {
            suggested: suggestion.generation_context?.suggested_lines ?? [],
            approved: finalItems,
          },
        }),
      ],
    );
    await client.query("COMMIT");
    res.json({
      suggestion: { ...suggestion, status: "approved" },
      recipe: finalItems,
      live_recipe_version: Number(nextLiveVersion.rows[0]?.recipe_version ?? 0),
      live_recipe_changed: true,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

export default router;