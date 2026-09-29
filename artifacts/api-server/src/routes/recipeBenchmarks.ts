import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { hasPageAccess, resolveWorkspace, workspace } from "../lib/workspace";
import {
  compareRecipeSuggestion,
  deterministicRecipeFingerprint,
  productType,
  RECIPE_SUGGESTION_ALIAS_VERSION,
  RECIPE_SUGGESTION_ENGINE_VERSION,
  RECIPE_SUGGESTION_METADATA_VERSION,
  RECIPE_SUGGESTION_PROMPT_VERSION,
  RECIPE_SUGGESTION_RULESET_VERSION,
  type RecipeComparison,
  type RecipeLineInput,
  type RecipeSuggestion,
  type SuggestionProduct,
} from "../lib/recipeSuggestionEngine";
import { loadRecipeGenerationRuntime } from "../lib/recipeGenerationRuntime";
import {
  FROZEN_RECIPE_BASELINE_V2,
  generateFrozenPreChangeRecipeSuggestion,
} from "../lib/recipeSuggestionBaselineV2";
import {
  buildRecipeBenchmarkMetrics,
  buildRecipeRegressionGate,
  recipeBenchmarkAnnotationScoringProjection,
  type StructuredRecipeAnnotation,
} from "../lib/recipeBenchmarkMetrics";
import {
  compareRecipeBenchmarkRuns,
  projectCanonicalRecipeFailures,
} from "../lib/recipeBenchmarkComparability";
import {
  EXPANDED_V1_RECIPE_BENCHMARK_COHORT,
  HISTORICAL_21_RECIPE_BENCHMARK_COHORT,
  RECIPE_EXPANDED_COHORT_V1,
  RECIPE_HISTORICAL_COHORT_21,
} from "../lib/recipeBenchmarkCohorts";
import {
  RECIPE_BENCHMARK_GOLD_BY_PRODUCT_ID,
  RECIPE_BENCHMARK_GOLD_EXPANDED_V1,
  type RecipeBenchmarkGoldCase,
} from "../lib/recipeBenchmarkGold";

const router = Router();
const MAX_SAMPLE_SIZE = 100;
const DEFAULT_SAMPLE_SIZE = 25;
/** The deliberately frozen implementation identifier for pre-change comparisons. */
const FROZEN_PRE_CHANGE_BASELINE_VERSION = FROZEN_RECIPE_BASELINE_V2;
type BenchmarkMode = "current" | "frozen_pre_change_baseline";

router.use(requireAuth, resolveWorkspace);

export { RECIPE_HISTORICAL_COHORT_21 };

const RECIPE_BENCHMARK_ALIGNMENT_SCHEMA_VERSION = "recipe-semantic-alignment-v2";
const RECIPE_BENCHMARK_METRIC_SCHEMA_VERSION = "recipe-benchmark-metrics-v4";
const RECIPE_BENCHMARK_SCORING_POLICY_VERSION = "canonical-reviewed-gold-v2";
const RECIPE_BENCHMARK_GOLD_VERSION = "expanded-v1-agent-draft";

type GoldQuality = "clean/consistent" | "questionable/legacy/incomplete" | "requires human confirmation";
export function independentGoldQuality(
  product: SuggestionProduct,
  baseItems: readonly RecipeLineInput[],
  operationalRules: { flowerBoxSponge: boolean; balloonMetalRing: boolean },
): { classification: GoldQuality; rationale: string } {
  const text = `${product.name} ${product.description ?? ""} ${product.descriptionAr ?? ""}`.toLowerCase();
  const humanReview: string[] = [];
  const legacyReview: string[] = [];
  const hasRecipeItem = (pattern: RegExp) => product.recipes.some(({ baseItemName }) => pattern.test(baseItemName));

  if (
    operationalRules.balloonMetalRing
    && /\bballoon\b/i.test(text)
    && !hasRecipeItem(/\bmetal ring\b/i)
  ) {
    legacyReview.push("the approved Recipe omits Metal Ring despite the governed balloon rule");
  }
  if (/\bsunflower bloom basket\b/i.test(text) && !hasRecipeItem(/\bbasket\b/i)) {
    legacyReview.push("Product text specifies a basket but the approved Recipe has no basket Base Item");
  }
  const roseQuantity = product.recipes.find(({ baseItemName }) => /\bpink roses?\b/i.test(baseItemName))?.quantity;
  const wrappingQuantity = product.recipes.find(({ baseItemName }) => /\bwrapping paper\b/i.test(baseItemName))?.quantity;
  if (
    /\bbundle of 30 pink roses\b/i.test(text)
    && roseQuantity != null
    && wrappingQuantity != null
    && wrappingQuantity > roseQuantity
  ) {
    humanReview.push("approved wrapping quantity is suspicious but not disproven by an approved standard");
  }
  if (
    /\bred dried limonium\b/i.test(text)
    && hasRecipeItem(/^red limonium$/i)
    && baseItems.some(({ baseItemName }) => /\bred dried limonium\b/i.test(baseItemName))
  ) {
    legacyReview.push("Product text and active catalog specify Red Dried Limonium while history uses a different generic Base Item");
  }
  if (humanReview.length > 0) return {
    classification: "requires human confirmation",
    rationale: `Independently authored Product/Recipe/rule/catalog review: ${[...humanReview, ...legacyReview].join("; ")}.`,
  };
  if (legacyReview.length > 0) return {
    classification: "questionable/legacy/incomplete",
    rationale: `Independently authored Product/Recipe/rule/catalog review: ${legacyReview.join("; ")}.`,
  };
  return {
    classification: "clean/consistent",
    rationale: "Product text, approved Recipe evidence, operational rules, and active catalog facts contain no pre-declared concern.",
  };
}

function canRunBenchmark(req: ReturnType<typeof workspace>): boolean {
  return req.workspaceRole === "owner" || hasPageAccess(req, "products.manage");
}

function canReadBenchmark(req: ReturnType<typeof workspace>): boolean {
  return canRunBenchmark(req) || hasPageAccess(req, "products");
}

/** GET /api/products/recipe-benchmarks — completed immutable reports available for comparison. */
router.get("/products/recipe-benchmarks", async (req, res) => {
  const wreq = workspace(req);
  if (!canReadBenchmark(wreq)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const runs = await db.query(
    `SELECT id, status, engine_version, version_manifest, sample_definition, sample_composition,
            exclusions, metrics, limitations, created_at, completed_at
       FROM recipe_benchmark_runs
      WHERE workspace_owner_id = $1 AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, id DESC
      LIMIT 100`,
    [wreq.workspaceOwnerId],
  );
  res.json({ runs: runs.rows });
});

function selectRepresentativeSample(
  products: SuggestionProduct[],
  sampleSize: number,
): SuggestionProduct[] {
  const strata = new Map<string, SuggestionProduct[]>();
  for (const product of products) {
    const key = `${product.category?.trim().toLowerCase() || "uncategorized"}:${productType(product)}`;
    const group = strata.get(key) ?? [];
    group.push(product);
    strata.set(key, group);
  }
  const groups = [...strata.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => group.sort((a, b) => a.id - b.id));
  const sample: SuggestionProduct[] = [];
  for (let index = 0; sample.length < sampleSize; index += 1) {
    let selected = false;
    for (const group of groups) {
      if (group[index]) {
        sample.push(group[index]);
        selected = true;
        if (sample.length === sampleSize) break;
      }
    }
    if (!selected) break;
  }
  return sample;
}

function composition(products: SuggestionProduct[]): Record<string, number> {
  return products.reduce<Record<string, number>>((acc, product) => {
    const key = `${product.category?.trim() || "Uncategorized"} / ${productType(product)}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function aggregateReport(
  records: Array<{ product: SuggestionProduct; suggestion: RecipeSuggestion; comparison: RecipeComparison }>,
) {
  const confidence = { high: 0, medium: 0, low: 0, no_match: 0 };
  const evidence = {
    deterministic_rule: 0,
    similar_product: 0,
    ai_assisted: 0,
    unresolved: 0,
    conflict: 0,
  };
  let expected = 0;
  let suggested = 0;
  let matched = 0;
  let quantityCompared = 0;
  let quantityCorrect = 0;
  let hiddenExpected = 0;
  let hiddenMatched = 0;
  const compatibilityRemovals: Record<string, number> = {};
  let saferAmbiguousOrNoMatch = 0;
  const groups = new Map<string, { products: number; f1Total: number; missing: number; extras: number; unresolved: number }>();

  for (const { product, suggestion, comparison } of records) {
    expected += comparison.baseItem.expectedCount;
    suggested += comparison.baseItem.suggestedCount;
    matched += comparison.baseItem.matchedCount;
    quantityCompared += comparison.quantity.comparedCount;
    quantityCorrect += comparison.quantity.correctCount;
    hiddenExpected += comparison.hiddenRule.expectedCount;
    hiddenMatched += comparison.hiddenRule.matchedCount;
    for (const requirement of suggestion.requirements) {
      if (requirement.resolution !== "matched" && (requirement.candidateCompatibility?.length ?? 0) > 0) {
        saferAmbiguousOrNoMatch += 1;
      }
      for (const diagnostic of requirement.candidateCompatibility ?? []) {
        for (const [attribute, decision] of Object.entries(diagnostic.comparisons)) {
          if (decision.state === "incompatible") {
            compatibilityRemovals[attribute] = (compatibilityRemovals[attribute] ?? 0) + 1;
          }
        }
      }
    }
    for (const key of Object.keys(confidence) as Array<keyof typeof confidence>) {
      confidence[key] += comparison.confidenceDistribution[key];
    }
    for (const key of Object.keys(evidence) as Array<keyof typeof evidence>) {
      evidence[key] += suggestion.evidenceSummary[key];
    }
    const groupKey = `${product.category?.trim() || "Uncategorized"} / ${comparison.productType}`;
    const group = groups.get(groupKey) ?? { products: 0, f1Total: 0, missing: 0, extras: 0, unresolved: 0 };
    group.products += 1;
    group.f1Total += comparison.baseItem.f1;
    group.missing += comparison.missingItems.length;
    group.extras += comparison.incorrectExtras.length;
    group.unresolved += comparison.unresolvedLines.length + comparison.conflicts.length;
    groups.set(groupKey, group);
  }
  const precision = suggested === 0 ? 0 : matched / suggested;
  const recall = expected === 0 ? 0 : matched / expected;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const errorProneGroups = [...groups.entries()]
    .map(([group, value]) => ({
      group,
      product_count: value.products,
      base_item_f1: Number((value.f1Total / value.products).toFixed(4)),
      missing_items: value.missing,
      incorrect_extras: value.extras,
      unresolved_or_conflicts: value.unresolved,
    }))
    .sort((a, b) => a.base_item_f1 - b.base_item_f1 || b.unresolved_or_conflicts - a.unresolved_or_conflicts);

  return {
    products_evaluated: records.length,
    base_item_match: {
      expected_lines: expected,
      suggested_lines: suggested,
      matched_lines: matched,
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1: Number(f1.toFixed(4)),
    },
    quantity_accuracy: {
      compared_lines: quantityCompared,
      correct_lines: quantityCorrect,
      accuracy: quantityCompared === 0 ? 0 : Number((quantityCorrect / quantityCompared).toFixed(4)),
    },
    hidden_rule_accuracy: {
      expected_operational_lines: hiddenExpected,
      matched_operational_lines: hiddenMatched,
      accuracy: hiddenExpected === 0 ? null : Number((hiddenMatched / hiddenExpected).toFixed(4)),
    },
    confidence_distribution: confidence,
    outcome_distribution: evidence,
    compatibility_gate_summary: {
      hard_removals_by_attribute: compatibilityRemovals,
      safer_ambiguous_or_no_match_requirements: saferAmbiguousOrNoMatch,
    },
    error_prone_product_types_and_categories: errorProneGroups,
  };
}

const benchmarkRequestSchema = z.object({
  sample_size: z.number().int().min(1).max(MAX_SAMPLE_SIZE).optional(),
  product_ids: z.array(z.number().int().positive()).min(1).max(MAX_SAMPLE_SIZE).optional(),
  cohort: z.enum(["historical_21", "expanded_v1"]).optional(),
  baseline_mode: z.enum(["current", "frozen_pre_change", "frozen_pre_change_baseline"]).optional(),
  /** Compare this run with an immutable benchmark in the same workspace. */
  baseline_run_id: z.number().int().positive().optional(),
});

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function benchmarkAnnotationFromGold(gold: RecipeBenchmarkGoldCase | undefined): StructuredRecipeAnnotation | undefined {
  if (!gold) return undefined;
  const incompatibleByRequirement = new Map<string, number[]>();
  const compatibleByRequirement = new Map<string, number[]>();
  for (const candidate of gold.compatibility_gold) {
    if (candidate.expected === "incompatible") {
      incompatibleByRequirement.set(candidate.requirement_key, [
        ...(incompatibleByRequirement.get(candidate.requirement_key) ?? []),
        candidate.candidate_base_item_id,
      ]);
    } else if (candidate.expected === "compatible") {
      compatibleByRequirement.set(candidate.requirement_key, [
        ...(compatibleByRequirement.get(candidate.requirement_key) ?? []),
        candidate.candidate_base_item_id,
      ]);
    }
  }
  const unknownByRequirement = new Map<string, number[]>();
  for (const candidate of gold.compatibility_gold) {
    if (candidate.expected !== "unknown") continue;
    unknownByRequirement.set(candidate.requirement_key, [
      ...(unknownByRequirement.get(candidate.requirement_key) ?? []),
      candidate.candidate_base_item_id,
    ]);
  }
  const retrievalByRequirement = new Map(
    gold.candidate_retrieval_gold.map((entry) => [entry.requirement_key, entry] as const),
  );
  const contextualByRequirement = new Map(
    (gold.contextual_resolver_gold ?? []).map((entry) => [entry.requirement_key, entry] as const),
  );
  const toSemanticLine = (line: RecipeBenchmarkGoldCase["final_recipe_expectation"]["lines"][number]) => ({
    id: line.requirement_key,
    kind: line.kind,
    subtype: line.subtype,
    phrase: line.source_phrase,
    semanticKey: line.semantic_attributes?.semantic_key,
    category: line.semantic_attributes?.category,
    ingredientFamily: line.semantic_attributes?.ingredient_family,
    color: line.semantic_attributes?.color,
    stemLengthCm: line.semantic_attributes?.stem_length_cm,
    format: line.semantic_attributes?.format,
    sourceField: line.source.field === "description_ar" ? "descriptionAr" : line.source.field,
    sourceOccurrence: line.source.occurrence,
    sourceSpanStart: line.source.span?.start,
    sourceSpanEnd: line.source.span?.end,
    quantity: line.quantity,
    unit: line.unit,
    baseItemId: line.expected_base_item_id ?? undefined,
    acceptableBaseItemIds: [...new Set([
      ...(line.expected_base_item_id == null ? [] : [line.expected_base_item_id]),
      ...(compatibleByRequirement.get(line.requirement_key) ?? []),
    ])],
    retrievalRelevantBaseItemIds: [
      ...(retrievalByRequirement.get(line.requirement_key)?.relevant_base_item_ids ?? []),
    ],
    knownIncompatibleBaseItemIds: incompatibleByRequirement.get(line.requirement_key) ?? [],
    knownUnknownBaseItemIds: unknownByRequirement.get(line.requirement_key) ?? [],
    expectedResolutionOutcome: retrievalByRequirement.get(line.requirement_key)?.expected_resolution_outcome,
    contextualRuleKey: contextualByRequirement.get(line.requirement_key)?.rule_key,
    provenance: {
      source: `${line.source.field}:${line.source.occurrence}`,
      evidence: {
        exact_phrase: line.source.exact_phrase,
        normalized_phrase: line.source.normalized_phrase,
        gold: gold.provenance.sources,
      },
    },
  });
  const acceptableVariants = gold.final_recipe_expectation.acceptable_variants
    ?? [{
      variant_id: `${gold.product_id}-provisional-v1`,
      lines: gold.final_recipe_expectation.lines,
      evidence_basis: gold.provenance.sources,
    }];
  return {
    productId: gold.product_id,
    status: gold.gold_review.state === "reviewed" || gold.gold_review.state === "adjudicated"
      ? "canonical"
      : "draft",
    finalRecipe: {
      disposition: gold.final_recipe_expectation.disposition,
      acceptableVariants: acceptableVariants.map((variant) => ({
        id: variant.variant_id,
        lines: variant.lines.map(toSemanticLine),
        disposition: variant.disposition,
        hiddenRules: (variant.hidden_rules ?? gold.hidden_rules).map((expectation) => ({
          ruleKey: expectation.rule_key,
          expected: expectation.expected,
          expectedCount: expectation.expected_count,
          acceptableBaseItemIds: expectation.acceptable_base_item_ids,
        })),
        provenance: {
          source: "agent_draft",
          evidence: variant.evidence_basis,
        },
      })),
    },
    expected: gold.format_gold?.authoritative_product_format === undefined
      ? undefined
      : { canonicalProductFormat: gold.format_gold.authoritative_product_format },
    formatExpectation: gold.format_gold ? {
      authoritativeProductFormat: gold.format_gold.authoritative_product_format,
      conflictExpected: gold.format_gold.conflict_expected,
      expectedResolvedPrimaryFormat: gold.format_gold.expected_resolved_primary_format,
    } : undefined,
    contextualResolvers: gold.contextual_resolver_gold?.map((expectation) => ({
      requirementId: expectation.requirement_key,
      ruleKey: expectation.rule_key,
      expectedOutcome: expectation.expected_outcome,
      expectedBaseItemId: expectation.expected_base_item_id,
    })),
    hiddenRules: gold.hidden_rules.map((expectation) => ({
      ruleKey: expectation.rule_key,
      expected: expectation.expected,
      expectedCount: expectation.expected_count,
      acceptableBaseItemIds: expectation.acceptable_base_item_ids,
    })),
    provenance: {
      source: gold.author_kind,
      sourceId: RECIPE_BENCHMARK_GOLD_VERSION,
      evidence: gold.provenance,
    },
    note: "Agent-authored draft gold; included in provisional metrics only.",
  };
}

function sameOrderedIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function benchmarkDefinitionForProductIds(productIds: readonly number[]) {
  const cohortManifest = sameOrderedIds(productIds, RECIPE_HISTORICAL_COHORT_21)
    ? HISTORICAL_21_RECIPE_BENCHMARK_COHORT
    : sameOrderedIds(productIds, RECIPE_EXPANDED_COHORT_V1)
      ? EXPANDED_V1_RECIPE_BENCHMARK_COHORT
      : {
          cohort_id: "explicit_product_ids",
          ordered_product_ids: productIds,
          selection_basis: "Caller-supplied explicit Product IDs.",
          selection_used_matcher_outputs: false as const,
        };
  const selectedGold = RECIPE_BENCHMARK_GOLD_EXPANDED_V1
    .filter(({ product_id }) => productIds.includes(product_id));
  const canonicalGold = selectedGold.filter(({ gold_review }) =>
    gold_review.state === "reviewed" || gold_review.state === "adjudicated");
  const provisionalGold = selectedGold.filter(({ gold_review }) =>
    gold_review.state === "draft" || gold_review.state === "needs_human_confirmation");
  const canonicalCohortManifest = "products" in cohortManifest
    ? {
        cohort_id: cohortManifest.cohort_id,
        freeze_status: cohortManifest.freeze_status,
        ordered_product_ids: cohortManifest.ordered_product_ids,
        selection_basis: cohortManifest.selection_basis,
        selection_used_matcher_outputs: cohortManifest.selection_used_matcher_outputs,
        products: cohortManifest.products,
        sentinels: cohortManifest.sentinels,
        coverage: cohortManifest.coverage,
        missing_strata: cohortManifest.missing_strata,
      }
    : {
        cohort_id: cohortManifest.cohort_id,
        ordered_product_ids: cohortManifest.ordered_product_ids,
        selection_basis: cohortManifest.selection_basis,
        selection_used_matcher_outputs: cohortManifest.selection_used_matcher_outputs,
      };
  return {
    cohort_manifest_version: String(cohortManifest.cohort_id),
    cohort_manifest_fingerprint: deterministicRecipeFingerprint(canonicalCohortManifest),
    semantic_gold_version: RECIPE_BENCHMARK_GOLD_VERSION,
    canonical_gold_fingerprint: deterministicRecipeFingerprint(canonicalGold.map((gold) => ({
      product_id: gold.product_id,
      scoring: recipeBenchmarkAnnotationScoringProjection(benchmarkAnnotationFromGold(gold)!),
    }))),
    provisional_gold_fingerprint: deterministicRecipeFingerprint(provisionalGold.map((gold) => ({
      product_id: gold.product_id,
      scoring: recipeBenchmarkAnnotationScoringProjection(benchmarkAnnotationFromGold(gold)!),
    }))),
    alignment_schema_version: RECIPE_BENCHMARK_ALIGNMENT_SCHEMA_VERSION,
    metric_schema_version: RECIPE_BENCHMARK_METRIC_SCHEMA_VERSION,
    scoring_policy_version: RECIPE_BENCHMARK_SCORING_POLICY_VERSION,
  };
}

function canonicalBenchmarkCaseInput(
  product: SuggestionProduct,
  supportingProducts: SuggestionProduct[],
): Record<string, unknown> {
  return {
    target_product_language_fields: {
      id: product.id,
      name: product.name,
      description: product.description ?? null,
      description_ar: product.descriptionAr ?? null,
      category: product.category ?? null,
      tags: [...(product.tags ?? [])],
    },
    target_recipe_withheld_from_generation: true,
    supporting_products: [...supportingProducts]
      .sort((left, right) => left.id - right.id)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        description: candidate.description ?? null,
        description_ar: candidate.descriptionAr ?? null,
        category: candidate.category ?? null,
        tags: [...(candidate.tags ?? [])],
        recipe: [...candidate.recipes].sort((left, right) => left.baseItemId - right.baseItemId),
      })),
  };
}

/**
 * Snapshot every input and decision needed to audit a benchmark without
 * re-reading mutable product, Base Item, or engine configuration data.
 * Fields not provided by a particular engine revision are recorded as null.
 */
function benchmarkDiagnostics(
  product: SuggestionProduct,
  supportingProducts: SuggestionProduct[],
  baseItems: RecipeLineInput[],
  suggestion: RecipeSuggestion,
  comparison: RecipeComparison,
  mode: BenchmarkMode,
) {
  const generated = optionalRecord(suggestion);
  const lines = Array.isArray(generated.lines) ? generated.lines : [];
  const unresolved = Array.isArray(generated.unresolvedLines) ? generated.unresolvedLines : [];
  const similar = Array.isArray(generated.similarProducts) ? generated.similarProducts : [];
  const conflicts = Array.isArray(generated.conflicts) ? generated.conflicts : [];
  const evidenceSummary = optionalRecord(generated.evidenceSummary);
  const deterministicCount = Number(evidenceSummary.deterministic_rule ?? 0);
  const similarCount = Number(evidenceSummary.similar_product ?? 0);
  const aiCount = Number(evidenceSummary.ai_assisted ?? 0);
  const candidateFailure = lines.length === 0 && unresolved.length > 0;
  const ruleFailure = deterministicCount === 0 && comparison.hiddenRule.expectedCount > 0;
  const similarFailure = similar.length === 0 && comparison.missingItems.length > 0;
  const aiFailure = aiCount === 0;
  const noMatch = lines.length === 0;
  const wrongMatch = comparison.incorrectExtras.length > 0
    || (comparison.baseItem.suggestedCount > 0 && comparison.baseItem.matchedCount === 0);

  return {
    immutable_version_manifest: {
      benchmark_mode: mode,
      engine: mode === "frozen_pre_change_baseline"
        ? FROZEN_PRE_CHANGE_BASELINE_VERSION
        : generated.engineVersion ?? RECIPE_SUGGESTION_ENGINE_VERSION,
      observed_engine: generated.engineVersion ?? RECIPE_SUGGESTION_ENGINE_VERSION,
      rules: generated.ruleSetVersion ?? RECIPE_SUGGESTION_RULESET_VERSION,
      // The deterministic engine has no configured aliases, prompt, or model.
      // Explicit nulls prevent a later live configuration from being inferred.
      aliases: generated.aliases ?? RECIPE_SUGGESTION_ALIAS_VERSION,
      metadata: generated.metadata ?? RECIPE_SUGGESTION_METADATA_VERSION,
      prompt: generated.prompt ?? RECIPE_SUGGESTION_PROMPT_VERSION,
      model: generated.model ?? null,
    },
    exact_generation_inputs: {
      target_product_language_fields: {
        id: product.id,
        name: product.name,
        description: product.description,
        description_ar: product.descriptionAr,
        category: product.category,
        tags: product.tags ?? [],
      },
      target_recipe_withheld_from_generation: true,
      candidate_universe: {
        base_items: baseItems,
        supporting_products: supportingProducts.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          description: candidate.description,
          category: candidate.category,
          tags: candidate.tags ?? [],
          recipe: candidate.recipes,
        })),
      },
      comparison_inputs: {
        approved_recipe: product.recipes,
        generated_lines: lines,
        missing_items: comparison.missingItems,
        incorrect_extras: comparison.incorrectExtras,
        quantity_tolerance: comparison.quantity.tolerance,
      },
    },
    failure_stage_classification: {
      extraction: unresolved.length > 0 ? "unresolved_requirement" : "not_failed",
      candidate: candidateFailure ? "no_candidate_match" : "not_failed",
      rule: ruleFailure ? "expected_operational_rule_not_matched" : "not_failed",
      similar: similarFailure ? "no_similar_evidence_for_missing_expected_item" : "not_failed",
      ai: aiFailure ? "not_executed_deterministic_benchmark" : "not_failed",
      conflicts: conflicts.length > 0 ? "conflicting_support" : "not_failed",
    },
    representative_outcome_flags: {
      wrong_match: wrongMatch,
      no_match: noMatch,
      has_unresolved_requirement: unresolved.length > 0,
    },
  };
}

/**
 * POST /api/products/recipe-benchmarks
 *
 * Runs a bounded, leave-one-out accuracy benchmark. The target's approved
 * recipe is loaded only for comparison and is never passed to the engine.
 */
router.post("/products/recipe-benchmarks", async (req, res) => {
  const wreq = workspace(req);
  if (!canRunBenchmark(wreq)) {
    res.status(403).json({ error: "Running recipe benchmarks requires owner access or Manage products permission" });
    return;
  }
  const parsed = benchmarkRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid benchmark sample", details: parsed.error.flatten() });
    return;
  }
  if (parsed.data.cohort === "expanded_v1") {
    res.status(409).json({
      error: "expanded_v1 discovery is pending in the intended workspace",
      code: "BENCHMARK_COHORT_FREEZE_PENDING",
      cohort: "expanded_v1",
      required_product_ids: [],
      sparse_snapshot_candidates_not_frozen:
        EXPANDED_V1_RECIPE_BENCHMARK_COHORT.discovery_candidates_not_frozen,
      reason: EXPANDED_V1_RECIPE_BENCHMARK_COHORT.pending_reason,
    });
    return;
  }
  if (parsed.data.product_ids && parsed.data.sample_size && parsed.data.product_ids.length > parsed.data.sample_size) {
    res.status(400).json({ error: "sample_size cannot be smaller than product_ids length" });
    return;
  }
  if (parsed.data.product_ids && parsed.data.cohort) {
    res.status(400).json({ error: "product_ids and cohort cannot be combined" });
    return;
  }
  if (
    parsed.data.product_ids
    && new Set(parsed.data.product_ids).size !== parsed.data.product_ids.length
  ) {
    res.status(400).json({ error: "product_ids must not contain duplicates" });
    return;
  }
  if (
    parsed.data.baseline_run_id != null
    && (parsed.data.product_ids != null || parsed.data.cohort != null || parsed.data.sample_size != null)
  ) {
    res.status(400).json({
      error: "baseline_run_id reruns its persisted cohort and cannot be combined with another cohort selector",
    });
    return;
  }
  const benchmarkMode: BenchmarkMode = parsed.data.baseline_mode === "frozen_pre_change"
    || parsed.data.baseline_mode === "frozen_pre_change_baseline"
    ? "frozen_pre_change_baseline"
    : "current";

  // A repeatable-read transaction gives the selection, evidence, comparison,
  // and persisted snapshots one consistent view. If any write fails, rollback
  // leaves no partial or falsely-completed run behind.
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    let baselineRun: {
      id: number;
      engine_version: string;
      version_manifest: Record<string, unknown>;
      sample_definition: Record<string, unknown>;
      metrics: Record<string, unknown>;
    } | null = null;
    let baselineResults: Array<{
      product_id: number;
      approved_recipe: unknown;
      evidence_used: unknown;
    }> = [];
    if (parsed.data.baseline_run_id != null) {
      const baselineResult = await client.query<{
        id: number;
        engine_version: string;
        version_manifest: Record<string, unknown>;
        sample_definition: Record<string, unknown>;
        metrics: Record<string, unknown>;
      }>(
        `SELECT id, engine_version, version_manifest, sample_definition, metrics
           FROM recipe_benchmark_runs
          WHERE id = $1 AND workspace_owner_id = $2`,
        [parsed.data.baseline_run_id, wreq.workspaceOwnerId],
      );
      if (baselineResult.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Recipe benchmark baseline not found" });
        return;
      }
      baselineRun = baselineResult.rows[0];
      const baselineResultRows = await client.query<{
        product_id: number;
        approved_recipe: unknown;
        evidence_used: unknown;
      }>(
        `SELECT product_id, approved_recipe, evidence_used
           FROM recipe_benchmark_results
          WHERE run_id = $1 AND workspace_owner_id = $2
          ORDER BY product_id ASC`,
        [baselineRun.id, wreq.workspaceOwnerId],
      );
      baselineResults = baselineResultRows.rows;
    }
    const runtime = await loadRecipeGenerationRuntime(client, wreq.workspaceOwnerId);
    const allProducts = runtime.candidateProducts;
    const baselineProductIds = baselineRun?.sample_definition.selected_product_ids;
    const baselineCohortIds = Array.isArray(baselineProductIds)
      ? baselineProductIds.filter((id): id is number => Number.isInteger(id) && id > 0)
      : undefined;
    const requestedIds = parsed.data.product_ids
      ?? (parsed.data.cohort === "historical_21"
        ? [...RECIPE_HISTORICAL_COHORT_21]
        : parsed.data.cohort === "expanded_v1"
          ? [...RECIPE_EXPANDED_COHORT_V1]
        : baselineCohortIds);
    if (
      baselineCohortIds
      && parsed.data.product_ids
      && (baselineCohortIds.length !== parsed.data.product_ids.length
        || baselineCohortIds.some((id, index) => id !== parsed.data.product_ids![index]))
    ) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "product_ids must match the selected baseline cohort" });
      return;
    }
    const requestedSet = requestedIds ? new Set(requestedIds) : null;
    const exclusions = allProducts
    .filter((product) => product.recipes.length === 0 && (!requestedSet || requestedSet.has(product.id)))
    .map((product) => ({ product_id: product.id, reason: "NO_COMPLETED_RECIPE" }));
    if (requestedIds) {
    const existingIds = new Set(allProducts.map((product) => product.id));
    for (const productId of requestedIds) {
      if (!existingIds.has(productId)) exclusions.push({ product_id: productId, reason: "NOT_FOUND_OR_ARCHIVED" });
    }
    }
    const completedProducts = allProducts.filter(
    (product) => product.recipes.length > 0 && (!requestedSet || requestedSet.has(product.id)),
  );
    const requestedSize = parsed.data.sample_size ?? (requestedIds?.length ?? DEFAULT_SAMPLE_SIZE);
    const sample = requestedIds
    ? completedProducts.sort((a, b) => requestedIds.indexOf(a.id) - requestedIds.indexOf(b.id))
    : selectRepresentativeSample(completedProducts, requestedSize);
    if (
      parsed.data.cohort
      && requestedIds
      && (sample.length !== requestedIds.length || exclusions.length > 0)
    ) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: "The frozen benchmark cohort is no longer fully evaluable",
        code: "BENCHMARK_FROZEN_COHORT_DRIFT",
        cohort: parsed.data.cohort,
        required_product_ids: requestedIds,
        successfully_evaluable_product_ids: sample.map((product) => product.id),
        exclusions,
      });
      return;
    }
    if (
      baselineRun
      && baselineCohortIds
      && (sample.length !== baselineCohortIds.length || exclusions.length > 0)
    ) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: "The persisted baseline cohort is no longer fully evaluable",
        code: "BENCHMARK_BASELINE_COHORT_DRIFT",
        required_product_ids: baselineCohortIds,
        successfully_evaluable_product_ids: sample.map((product) => product.id),
        exclusions,
      });
      return;
    }
    if (sample.length === 0) {
      await client.query("ROLLBACK");
      res.status(422).json({ error: "No completed, non-archived products are available for this benchmark", exclusions });
      return;
    }

    const baseItems = runtime.baseItems;
    const productionConfiguration = runtime.configuration;
    const records = sample.map((product) => {
      const supportingProducts = runtime.supportingProductsFor(product.id);
      // Structural leave-one-out boundary: only comparison sees product.recipes.
      const { recipes: approvedRecipe, ...generationTarget } = product;
      const productionRuntimeCase = runtime.runForTarget(product.id);
      const productionMatcherRun = productionRuntimeCase?.matcherRun ?? null;
      const matcherRun = benchmarkMode === "frozen_pre_change_baseline"
        ? null
        : productionMatcherRun;
      const suggestion = matcherRun
        ? matcherRun.suggestion
        : generateFrozenPreChangeRecipeSuggestion(generationTarget, supportingProducts, baseItems);
      const comparison = compareRecipeSuggestion(suggestion, approvedRecipe, product);
      return {
        product,
        supportingProducts,
        suggestion,
        comparison,
        generationSafety: {
          targetRecipeInputPresent: Object.prototype.hasOwnProperty.call(generationTarget, "recipes"),
          targetCorrectionHistoryInputPresent:
            Object.keys(generationTarget).some((key) => /correction/i.test(key)),
          supportingProductIds: supportingProducts.map((candidate) => candidate.id),
        },
        matcherRun,
        productionMatcherRun,
        annotation: benchmarkAnnotationFromGold(RECIPE_BENCHMARK_GOLD_BY_PRODUCT_ID.get(product.id)),
        goldQuality: independentGoldQuality(product, baseItems, productionConfiguration.operationalRules),
      };
    });
    const metrics = {
      ...aggregateReport(records),
      ...buildRecipeBenchmarkMetrics(records),
    };
    const configurationFingerprint = records.find(({ productionMatcherRun }) => productionMatcherRun)
      ?.productionMatcherRun?.configurationFingerprint
      ?? deterministicRecipeFingerprint({
        engine: FROZEN_PRE_CHANGE_BASELINE_VERSION,
        baseItems,
        rules: RECIPE_SUGGESTION_RULESET_VERSION,
      });
    const benchmarkDefinition = benchmarkDefinitionForProductIds(sample.map(({ id }) => id));
    // Keep generation's legacy response fields, while sourcing the canonical
    // definition/configuration comparison from the same pure contract used by
    // the read-only comparison endpoint. Generation has not yet persisted its
    // candidate snapshots, so its historical input-drift fields remain below.
    const sharedComparability = baselineRun
      ? compareRecipeBenchmarkRuns(
        baselineRun,
        {
          id: -1,
          version_manifest: {
            configuration_fingerprint: configurationFingerprint,
            benchmark_definition: benchmarkDefinition,
          },
          sample_definition: {
            selected_product_ids: sample.map(({ id }) => id),
            successfully_evaluated_product_ids: records.map(({ product }) => product.id),
          },
          metrics,
        },
        baselineResults,
        records.map(({ product, productionMatcherRun }) => ({
          product_id: product.id,
          evidence_used: {
            production_case_input_fingerprint: productionMatcherRun?.caseInputFingerprint ?? null,
            production_case_input_snapshot: productionMatcherRun?.caseInputSnapshot ?? null,
          },
        })),
      )
      : null;
    const baselineDefinition = baselineRun
      ? optionalRecord(optionalRecord(baselineRun.version_manifest).benchmark_definition)
      : null;
    const canonicalDefinitionFields = [
      "cohort_manifest_fingerprint",
      "canonical_gold_fingerprint",
      "alignment_schema_version",
      "metric_schema_version",
      "scoring_policy_version",
    ] as const;
    const missingLegacyDefinition = baselineRun != null && (
      !baselineDefinition
      || Object.keys(baselineDefinition).length === 0
      || sharedComparability?.comparability.missing_canonical_definition_fields
        .some((field) => field.startsWith("baseline.")) === true
    );
    const changedCanonicalDefinitionFields = sharedComparability
      ? sharedComparability.comparability.changed_canonical_definition_fields
      : baselineDefinition
      ? canonicalDefinitionFields.filter((field) => baselineDefinition[field] !== benchmarkDefinition[field])
      : [];
    const baselineConfigurationFingerprint = sharedComparability
      ? sharedComparability.comparability.baseline_configuration_fingerprint
      : baselineRun == null
      ? null
      : typeof optionalRecord(baselineRun.version_manifest).configuration_fingerprint === "string"
        ? optionalRecord(baselineRun.version_manifest).configuration_fingerprint as string
        : null;
    const missingBaselineConfigurationFingerprint =
      baselineRun != null && baselineConfigurationFingerprint == null;
    const configurationFingerprintMismatch = sharedComparability
      ? !sharedComparability.comparability.production_configuration_match && baselineConfigurationFingerprint != null
      : baselineConfigurationFingerprint != null && baselineConfigurationFingerprint !== configurationFingerprint;
    const changedProductionConfigurationFields = configurationFingerprintMismatch
      ? ["configuration_fingerprint"]
      : [];
    const inputDriftProductIds = sharedComparability?.comparability.input_drift_product_ids ?? [];
    const missingBaselineSnapshotProductIds = [...new Set([
      ...(sharedComparability?.comparability.missing_baseline_result_product_ids ?? []),
      ...(sharedComparability?.comparability.missing_baseline_snapshot_product_ids ?? []),
      ...(sharedComparability?.comparability.missing_baseline_fingerprint_product_ids ?? []),
    ])].sort((left, right) => left - right);
    const missingCandidateSnapshotProductIds = [...new Set([
      ...(sharedComparability?.comparability.missing_candidate_result_product_ids ?? []),
      ...(sharedComparability?.comparability.missing_candidate_snapshot_product_ids ?? []),
      ...(sharedComparability?.comparability.missing_candidate_fingerprint_product_ids ?? []),
    ])].sort((left, right) => left - right);
    const calculatedRegressionGate = buildRecipeRegressionGate(
      metrics,
      baselineRun?.metrics ?? null,
      baselineRun?.id ?? null,
    );
    const regressionGate = baselineRun
      && (
        inputDriftProductIds.length > 0
        || missingBaselineSnapshotProductIds.length > 0
        || missingLegacyDefinition
        || changedCanonicalDefinitionFields.length > 0
        || missingBaselineConfigurationFingerprint
        || configurationFingerprintMismatch
        || sharedComparability?.comparability.comparable === false
      )
      ? {
          ...calculatedRegressionGate,
          status: "incomparable" as const,
          flagged_formats: [],
          input_drift_product_ids: inputDriftProductIds,
          missing_baseline_snapshot_product_ids: missingBaselineSnapshotProductIds,
          missing_candidate_snapshot_product_ids: missingCandidateSnapshotProductIds,
          changed_canonical_definition_fields: changedCanonicalDefinitionFields,
          changed_production_configuration_fields: changedProductionConfigurationFields,
          baseline_configuration_fingerprint: baselineConfigurationFingerprint,
          current_configuration_fingerprint: configurationFingerprint,
          reason: missingBaselineConfigurationFingerprint
            ? "Persisted baseline lacks the required production configuration fingerprint."
            : configurationFingerprintMismatch
              ? "Production configuration fingerprint differs from the persisted baseline."
              : missingLegacyDefinition
            ? "Legacy benchmark definition lacks required canonical definition fingerprints."
            : changedCanonicalDefinitionFields.length > 0
              ? "Canonical cohort, gold, alignment, metric, or scoring-policy definition differs from the baseline."
              : sharedComparability?.comparability.reasons[0]
                ? sharedComparability.comparability.reasons[0]
              : "Immutable target, expected Recipe, or supporting-evidence inputs differ from the baseline.",
        }
      : calculatedRegressionGate;
    const cleanRecords = records.filter(({ goldQuality }) => goldQuality.classification === "clean/consistent");
    const cleanGoldMetrics = aggregateReport(cleanRecords);
    const sampleDefinition = {
    benchmark_mode: benchmarkMode,
    baseline_linkage: {
      baseline_run_id: baselineRun?.id ?? null,
      baseline_engine_version: baselineRun?.engine_version ?? null,
      same_frozen_cohort: baselineRun != null
        && baselineCohortIds?.length === sample.length
        && baselineCohortIds.every((id, index) => sample[index]?.id === id),
      immutable_inputs_match: baselineRun == null
        ? null
        : inputDriftProductIds.length === 0
          && missingBaselineSnapshotProductIds.length === 0
          && missingCandidateSnapshotProductIds.length === 0,
      production_configuration_match: baselineRun == null
        ? null
        : baselineConfigurationFingerprint != null && !configurationFingerprintMismatch,
      baseline_configuration_fingerprint: baselineConfigurationFingerprint,
      current_configuration_fingerprint: configurationFingerprint,
      regression_gate: regressionGate,
      benchmark_definition: benchmarkDefinition,
    },
    immutable_version_manifest: {
      engine: benchmarkMode === "frozen_pre_change_baseline"
        ? FROZEN_PRE_CHANGE_BASELINE_VERSION
        : RECIPE_SUGGESTION_ENGINE_VERSION,
      rules: RECIPE_SUGGESTION_RULESET_VERSION,
      aliases: RECIPE_SUGGESTION_ALIAS_VERSION,
      metadata: RECIPE_SUGGESTION_METADATA_VERSION,
      prompt: RECIPE_SUGGESTION_PROMPT_VERSION,
      ai_provider: "openai",
      model: benchmarkMode === "frozen_pre_change_baseline"
        ? null
        : productionConfiguration.boundedAi.model,
      ai_settings: {
        temperature: 0,
        response_format: "json_object",
        bounded_candidate_selection: true,
      },
      configuration_fingerprint: configurationFingerprint,
      benchmark_definition: benchmarkDefinition,
    },
    mode: parsed.data.cohort ?? (requestedIds ? "explicit_product_ids" : "stratified_category_and_product_type"),
    requested_sample_size: requestedSize,
    selected_product_ids: sample.map((product) => product.id),
    successfully_evaluated_product_ids: records.map(({ product }) => product.id),
    excluded_products: exclusions,
    direct_recipe_withheld:
      optionalRecord(optionalRecord(metrics).benchmark_leakage_safety).target_recipe_withheld === true,
    target_product_specific_correction_withheld:
      optionalRecord(optionalRecord(metrics).benchmark_leakage_safety)
        .target_correction_history_withheld === true,
    target_leakage_safety: optionalRecord(metrics).benchmark_leakage_safety,
    supporting_evidence: "other completed products in the same workspace only",
    structured_annotation_corpus: {
      version: RECIPE_BENCHMARK_GOLD_VERSION,
      evaluated_product_ids: records.filter(({ annotation }) => annotation).map(({ product }) => product.id),
      author_kind: "agent",
      review_state: "draft",
      canonical_scoring_eligible: false,
      provisional_diagnostics_only: true,
    },
    frozen_cohort: parsed.data.cohort === "historical_21"
      ? HISTORICAL_21_RECIPE_BENCHMARK_COHORT
      : null,
    bounded_ai: {
      executed: false,
      policy: productionConfiguration.boundedAi,
      provider: "openai",
      outcome: "not_executed_deterministic_benchmark",
      limitation: "AI was skipped; deterministic parity does not establish AI-output parity.",
    },
    deterministic_parity_limitations: runtime.parityLimitations,
    historical_clean_recipe_reporting: {
      full_denominator: records.length,
      historical_clean_recipe_denominator: cleanRecords.length,
      excluded: records.filter(({ goldQuality }) => goldQuality.classification !== "clean/consistent")
        .map(({ product, goldQuality }) => ({ product_id: product.id, ...goldQuality })),
      rationale: "Historical Recipe quality is independently classified from Product text, approved Recipe evidence, operational rules, and catalog facts—not matcher agreement.",
      limitations: "Historical approval does not by itself prove completeness or correctness.",
    },
  };
    const limitations = [
    "This benchmark uses deterministic matching and similar approved recipe evidence; AI-assisted matching is not enabled in this engine version.",
    "Operational-item accuracy identifies packaging-like Base Items by name, so owners should review category-specific hidden rules manually.",
    "A benchmark compares against existing approved recipes; it does not establish that historical recipes are complete or correct.",
    "Bounded AI was not executed. Deterministic parity does not establish AI-output parity.",
    "Structured extraction accuracy is scored only for the independently annotated subset; approved Base Item names are never extraction labels.",
    "Regression flags are decision support only and never change rule or learning state.",
    ...runtime.parityLimitations,
  ];

  // All generation and comparison work above is read-only. The only writes
  // below are append-only benchmark snapshots; product_recipes is never mutated.
    const runResult = await client.query<{ id: number }>(
    `INSERT INTO recipe_benchmark_runs (
       workspace_owner_id, created_by_user_id, created_by_email, status, engine_version,
       version_manifest, sample_definition, sample_composition, exclusions, metrics, limitations, completed_at
     ) VALUES ($1, $2, $3, 'completed', $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, now())
     RETURNING id`,
    [
      wreq.workspaceOwnerId,
      wreq.userId,
      wreq.userEmail,
       benchmarkMode === "frozen_pre_change_baseline"
         ? FROZEN_PRE_CHANGE_BASELINE_VERSION
         : RECIPE_SUGGESTION_ENGINE_VERSION,
      JSON.stringify(sampleDefinition.immutable_version_manifest),
      JSON.stringify(sampleDefinition),
      JSON.stringify(composition(sample)),
      JSON.stringify(exclusions),
      JSON.stringify(metrics),
      JSON.stringify(limitations),
    ],
  );
    const runId = runResult.rows[0].id;
    for (const {
      product,
      supportingProducts,
      suggestion,
      comparison,
      matcherRun,
      productionMatcherRun,
      annotation,
      goldQuality,
    } of records) {
      const diagnostics = benchmarkDiagnostics(
        product,
        supportingProducts,
        baseItems,
        suggestion,
        comparison,
        benchmarkMode,
      );
      const supportingRecipeSnapshots = supportingProducts
        .filter((candidate) => suggestion.leaveOneOut.supportingProductIds.includes(candidate.id))
        .map((candidate) => ({
          product: {
            id: candidate.id,
            name: candidate.name,
            description: candidate.description,
            description_ar: candidate.descriptionAr,
            category: candidate.category,
            tags: candidate.tags,
          },
          recipe: candidate.recipes,
        }));
      await client.query(
      `INSERT INTO recipe_benchmark_results (
         workspace_owner_id, run_id, product_id, product_snapshot, approved_recipe,
         generated_suggestion, evidence_used, comparison
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)`,
      [
        wreq.workspaceOwnerId,
        runId,
        product.id,
        JSON.stringify({
          id: product.id,
          name: product.name,
          description: product.description,
          description_ar: product.descriptionAr,
          category: product.category,
          tags: product.tags,
          product_type: productType(product),
          canonical_format: suggestion.structure.formatResolution.authoritativePrimaryFormat
            ?? suggestion.structure.productFormat.value
            ?? "Unknown",
        }),
        JSON.stringify(product.recipes),
        JSON.stringify(suggestion),
        JSON.stringify({
          similar_products: suggestion.similarProducts,
          supporting_recipe_snapshots: supportingRecipeSnapshots,
          base_item_universe: runtime.baseItemRows,
          engine_version: suggestion.engineVersion,
          ruleset_version: RECIPE_SUGGESTION_RULESET_VERSION,
          leave_one_out: suggestion.leaveOneOut,
          outcome_distribution: suggestion.evidenceSummary,
           configuration_fingerprint: matcherRun?.configurationFingerprint ?? configurationFingerprint,
           case_input_fingerprint: matcherRun?.caseInputFingerprint ?? deterministicRecipeFingerprint({
             targetProductId: product.id,
             target: { ...product, recipes: undefined },
             supportingProducts,
             targetRecipeWithheld: true,
           }),
           production_case_input_fingerprint: productionMatcherRun?.caseInputFingerprint ?? null,
           production_case_input_snapshot: productionMatcherRun?.caseInputSnapshot ?? null,
           benchmark_case_input_fingerprint: deterministicRecipeFingerprint(
             canonicalBenchmarkCaseInput(product, supportingProducts),
           ),
           benchmark_case_input_snapshot: canonicalBenchmarkCaseInput(product, supportingProducts),
           configuration_snapshot: matcherRun?.configurationSnapshot ?? null,
           case_input_snapshot: matcherRun?.caseInputSnapshot ?? null,
           bounded_ai: {
             executed: false,
             policy: productionConfiguration.boundedAi,
             limitation: "AI was skipped; deterministic parity does not establish AI-output parity.",
           },
            deterministic_parity_limitations: runtime.parityLimitations,
           historical_gold_quality: goldQuality,
           structured_annotation: annotation ?? null,
           ...diagnostics,
        }),
        JSON.stringify(comparison),
      ],
    );
    }
    await client.query("COMMIT");

    res.status(201).json({
    run_id: runId,
    status: "completed",
     engine_version: benchmarkMode === "frozen_pre_change_baseline"
       ? FROZEN_PRE_CHANGE_BASELINE_VERSION
       : RECIPE_SUGGESTION_ENGINE_VERSION,
    sample_definition: sampleDefinition,
    sample_composition: composition(sample),
    exclusions,
    metrics,
    regression_gate: regressionGate,
    limitations,
    historical_clean_recipe_metrics: cleanGoldMetrics,
    historical_cohort: {
      exact_requested_cohort: RECIPE_HISTORICAL_COHORT_21.every((id) => sample.some((product) => product.id === id))
        && sample.length === RECIPE_HISTORICAL_COHORT_21.length,
      required_product_ids: RECIPE_HISTORICAL_COHORT_21,
      full_denominator: records.length,
      historical_clean_recipe_denominator: cleanRecords.length,
    },
    results: records.map(({
      product,
      supportingProducts,
      suggestion,
      comparison,
      matcherRun,
      productionMatcherRun,
      annotation,
      goldQuality,
    }) => {
      const diagnostics = benchmarkDiagnostics(
        product,
        supportingProducts,
        baseItems,
        suggestion,
        comparison,
        benchmarkMode,
      );
      return {
      product_id: product.id,
      product_name: product.name,
      canonical_format: suggestion.structure.formatResolution.authoritativePrimaryFormat
        ?? suggestion.structure.productFormat.value
        ?? "Unknown",
      category: product.category ?? "Uncategorized",
      comparison,
      structured_annotation: annotation ?? null,
      structured_extraction: suggestion.structure,
      diagnostics,
      evidence_used: {
        similar_products: suggestion.similarProducts,
        leave_one_out: suggestion.leaveOneOut,
        outcome_distribution: suggestion.evidenceSummary,
        configuration_fingerprint: matcherRun?.configurationFingerprint ?? configurationFingerprint,
        case_input_fingerprint: matcherRun?.caseInputFingerprint ?? null,
        production_case_input_fingerprint: productionMatcherRun?.caseInputFingerprint ?? null,
        benchmark_case_input_fingerprint: deterministicRecipeFingerprint(
          canonicalBenchmarkCaseInput(product, supportingProducts),
        ),
        bounded_ai: {
          executed: false,
          policy: productionConfiguration.boundedAi,
          limitation: "AI was skipped; deterministic parity does not establish AI-output parity.",
        },
        historical_gold_quality: goldQuality,
      },
    };
    }),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

/** GET /api/products/recipe-benchmarks/compare — read-only immutable comparison. */
router.get("/products/recipe-benchmarks/compare", async (req, res) => {
  const wreq = workspace(req);
  if (!canReadBenchmark(wreq)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const baselineRunId = Number(req.query.baseline_run_id);
  const candidateRunId = Number(req.query.candidate_run_id);
  if (
    !Number.isInteger(baselineRunId) || baselineRunId < 1
    || !Number.isInteger(candidateRunId) || candidateRunId < 1
    || baselineRunId === candidateRunId
  ) {
    res.status(400).json({ error: "baseline_run_id and candidate_run_id must be distinct positive integer IDs" });
    return;
  }
  const runs = await db.query<{
    id: number; status: string; engine_version: string; version_manifest: Record<string, unknown>;
    sample_definition: Record<string, unknown>; sample_composition: unknown; exclusions: unknown;
    metrics: Record<string, unknown>; limitations: unknown; created_at: unknown; completed_at: unknown;
  }>(
    `SELECT id, status, engine_version, version_manifest, sample_definition, sample_composition, exclusions,
            metrics, limitations, created_at, completed_at
       FROM recipe_benchmark_runs
      WHERE id = ANY($1::int[]) AND workspace_owner_id = $2 AND status = 'completed'`,
    [[baselineRunId, candidateRunId], wreq.workspaceOwnerId],
  );
  const byId = new Map(runs.rows.map((run) => [run.id, run]));
  const baseline = byId.get(baselineRunId);
  const candidate = byId.get(candidateRunId);
  if (!baseline || !candidate) {
    res.status(404).json({ error: "Completed Recipe benchmark run not found" });
    return;
  }
  const results = await db.query<{
    run_id: number; product_id: number; product_snapshot: unknown; approved_recipe: unknown;
    generated_suggestion: unknown; evidence_used: unknown; comparison: unknown; created_at: unknown;
  }>(
    `SELECT run_id, product_id, product_snapshot, approved_recipe, generated_suggestion,
            evidence_used, comparison, created_at
       FROM recipe_benchmark_results
      WHERE run_id = ANY($1::int[]) AND workspace_owner_id = $2
      ORDER BY run_id ASC, product_id ASC`,
    [[baselineRunId, candidateRunId], wreq.workspaceOwnerId],
  );
  const baselineResults = results.rows.filter((row) => row.run_id === baselineRunId);
  const candidateResults = results.rows.filter((row) => row.run_id === candidateRunId);
  const comparison = compareRecipeBenchmarkRuns(baseline, candidate, baselineResults, candidateResults);
  res.json({
    baseline: { run: baseline, results: baselineResults },
    candidate: { run: candidate, results: candidateResults },
    comparability: comparison.comparability,
    regression_gate: comparison.regression_gate,
    canonical_failures: projectCanonicalRecipeFailures(candidate.metrics, candidateResults),
  });
});

/** GET /api/products/recipe-benchmarks/:id — immutable owner-review report. */
router.get("/products/recipe-benchmarks/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canReadBenchmark(wreq)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const runId = Number(req.params.id);
  if (!Number.isInteger(runId) || runId < 1) {
    res.status(400).json({ error: "Invalid benchmark run id" });
    return;
  }
  const run = await db.query(
    `SELECT id, status, engine_version, version_manifest, sample_definition, sample_composition, exclusions,
            metrics, limitations, created_at, completed_at
       FROM recipe_benchmark_runs
      WHERE id = $1 AND workspace_owner_id = $2 AND status = 'completed'`,
    [runId, wreq.workspaceOwnerId],
  );
  if (run.rowCount === 0) {
    res.status(404).json({ error: "Completed Recipe benchmark run not found" });
    return;
  }
  const results = await db.query(
    `SELECT product_id, product_snapshot, approved_recipe, generated_suggestion,
            evidence_used, comparison, created_at
       FROM recipe_benchmark_results
      WHERE run_id = $1 AND workspace_owner_id = $2
      ORDER BY product_id ASC`,
    [runId, wreq.workspaceOwnerId],
  );
  res.json({ run: run.rows[0], results: results.rows });
});

export default router;