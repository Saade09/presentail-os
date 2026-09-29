import type {
  CanonicalProductFormat,
  ProductStructure,
  RecipeComparison,
  RecipeRequirement,
  RecipeSuggestion,
  SuggestionProduct,
} from "./recipeSuggestionEngine";
import {
  deterministicRecipeFingerprint,
  isGovernedOperationalHiddenRuleKey,
} from "./recipeSuggestionEngine";

/*
 * These deliberately narrow structural types mirror recipeBenchmarkGold.  They
 * live here until the reviewed corpus lands, and allow the corpus types to be
 * assigned without an adapter (additional gold fields are harmless).
 */
export type BenchmarkProvenance = {
  source?: string;
  sourceId?: string | number;
  reviewedBy?: string;
  reviewedAt?: string;
  evidence?: unknown;
};

export type SemanticRecipeLine = {
  id?: string;
  requirementId?: string;
  kind?: string;
  subtype?: string | null;
  category?: string | null;
  phrase?: string;
  sourceField?: string;
  sourceOccurrence?: number;
  sourceSpanStart?: number;
  sourceSpanEnd?: number;
  semanticKey?: string;
  ingredientFamily?: string | null;
  color?: string | null;
  stemLengthCm?: number | null;
  format?: CanonicalProductFormat | null;
  quantity?: number | null;
  unit?: string | null;
  baseItemId?: number;
  acceptableBaseItemIds?: number[];
  retrievalRelevantBaseItemIds?: number[];
  candidateBaseItemIds?: number[];
  knownIncompatibleBaseItemIds?: number[];
  knownUnknownBaseItemIds?: number[];
  hiddenRuleKey?: string | null;
  contextualRuleKey?: string | null;
  expectedResolutionOutcome?: "resolved" | "ambiguous" | "no_match";
  provenance?: BenchmarkProvenance | null;
};

export type RecipeAcceptableVariant = {
  id?: string;
  lines?: SemanticRecipeLine[];
  requirements?: SemanticRecipeLine[];
  provenance?: BenchmarkProvenance | null;
  hiddenRules?: StructuredRecipeAnnotation["hiddenRules"];
  disposition?: "complete" | "partial_catalog_coverage";
};

export type StructuredRecipeAnnotation = {
  productId: number;
  status?: "canonical" | "provisional" | "draft";
  expected?: {
    ingredientFamily?: string | null;
    color?: string | null;
    canonicalProductFormat?: CanonicalProductFormat | null;
    stemLengthCm?: number | null;
    dimensionsCm?: number[] | null;
    shape?: string | null;
    material?: string | null;
    packageCount?: number | null;
  };
  acceptableVariants?: RecipeAcceptableVariant[];
  finalRecipe?: {
    acceptableVariants: RecipeAcceptableVariant[];
    disposition?: "complete" | "partial_catalog_coverage";
  };
  formatExpectation?: {
    authoritativeProductFormat?: CanonicalProductFormat | null;
    conflictExpected?: boolean;
    expectedResolvedPrimaryFormat?: CanonicalProductFormat | null;
  };
  contextualResolvers?: Array<{
    requirementId?: string;
    semanticKey?: string;
    ruleKey: string;
    expectedOutcome: "applied" | "rejected";
    expectedBaseItemId?: number | null;
  }>;
  hiddenRules?: Array<{
    ruleKey: string;
    expected: boolean;
    expectedCount?: number;
    acceptableBaseItemIds?: readonly number[];
  }>;
  provenance?: BenchmarkProvenance | null;
  note?: string;
};

/** The old four-product embedded corpus was not independently versioned gold. */
export const RECIPE_STRUCTURED_ANNOTATION_CORPUS: readonly StructuredRecipeAnnotation[] = [];

export type RecipeBenchmarkRecord = {
  product: SuggestionProduct;
  suggestion: RecipeSuggestion;
  comparison: RecipeComparison;
  annotation?: StructuredRecipeAnnotation;
  generationStatus?: "scored" | "failed" | "unsupported";
  generationSafety?: {
    targetRecipeInputPresent: boolean;
    targetCorrectionHistoryInputPresent: boolean;
    supportingProductIds: readonly number[];
  };
};

export type CountMetric = {
  evaluated: number;
  correct: number;
  accuracy: number | null;
};

const round = (value: number): number => Number(value.toFixed(4));
const countMetric = (evaluated: number, correct: number): CountMetric => ({
  evaluated,
  correct,
  accuracy: evaluated === 0 ? null : round(correct / evaluated),
});
const normalized = (value: unknown): string => String(value ?? "").trim().toLowerCase()
  .replace(/\s+/g, " ").replace(/^roses$/, "rose").replace(/^rectangular$/, "rectangle");
const sameValue = (expected: unknown, actual: unknown): boolean => {
  if (typeof expected === "string" || typeof actual === "string") return normalized(expected) === normalized(actual);
  if (typeof expected === "number" || typeof actual === "number") {
    return expected != null && actual != null && Math.abs(Number(expected) - Number(actual)) <= 0.01;
  }
  return expected === actual;
};
const sameDimensions = (expected: number[] | null | undefined, actual: number[]): boolean => {
  if (expected == null) return actual.length === 0;
  if (expected.length !== actual.length) return false;
  const remaining = [...actual];
  return expected.every((value) => {
    const index = remaining.findIndex((candidate) => Math.abs(candidate - value) <= 0.01);
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
};

function structureValue(structure: ProductStructure, field: string): unknown {
  switch (field) {
    case "ingredientFamily": return structure.ingredientFamily.value;
    case "color": return structure.color.value;
    case "canonicalProductFormat": return structure.formatResolution.authoritativePrimaryFormat ?? structure.productFormat.value;
    case "stemLengthCm": return structure.stemLength.value?.centimeters ?? null;
    case "dimensionsCm": return structure.dimensions.map(({ centimeters }) => centimeters);
    case "shape": return structure.shape.value;
    case "material": return structure.material.value;
    case "packageCount": return structure.packageCount.value;
    default: return undefined;
  }
}

export function compareStructuredAnnotation(structure: ProductStructure, annotation: StructuredRecipeAnnotation) {
  const fields: Record<string, CountMetric> = {};
  let evaluated = 0;
  let correct = 0;
  for (const [field, expected] of Object.entries(annotation.expected ?? {})) {
    if (expected === undefined) continue;
    const actual = structureValue(structure, field);
    const matches = field === "dimensionsCm"
      ? sameDimensions(expected as number[] | null, (actual as number[]) ?? [])
      : sameValue(expected, actual);
    fields[field] = countMetric(1, matches ? 1 : 0);
    evaluated++;
    if (matches) correct++;
  }
  return { fields, evaluated, correct, accuracy: evaluated ? round(correct / evaluated) : null };
}

type ActualSemanticLine = SemanticRecipeLine & {
  requirement: RecipeRequirement;
  preCompatibilityCandidateBaseItemIds?: number[];
  selectedBaseItemId?: number;
  selectedRequirementProvenance?: RecipeRequirement | null;
};

export type SemanticAlignment = {
  variant_id: string | null;
  variant_index: number | null;
  pairs: Array<{ expected_index: number; actual_index: number; expected_id: string | null; actual_id: string | null }>;
  unmatched_expected: number[];
  unmatched_actual: number[];
  ambiguous: boolean;
  optimal_alignment_count: number;
  candidate_retrieval: CountMetric;
  compatibility: CountMetric;
  compatibility_breakdown: {
    allowed_survival: CountMetric;
    known_incompatible_exclusion: CountMetric;
    expected_unknown_survival: CountMetric;
  };
  resolution: CountMetric;
  quantity: CountMetric;
  provenance_integrity: CountMetric;
};

const values = (line: SemanticRecipeLine, key: string): unknown => {
  if (key in line) return (line as Record<string, unknown>)[key];
  return undefined;
};

function semanticCompatibility(expected: SemanticRecipeLine, actual: SemanticRecipeLine): number {
  const discriminators = [
    "sourceField", "sourceOccurrence", "sourceSpanStart", "sourceSpanEnd",
    "semanticKey", "kind", "subtype", "category", "ingredientFamily", "color",
    "stemLengthCm", "format", "hiddenRuleKey", "contextualRuleKey",
  ];
  let score = 1; // an intentionally generic gold line can align to any line
  if (expected.phrase) {
    const wanted = normalized(expected.phrase);
    const got = normalized(actual.phrase);
    if (!got || (!got.includes(wanted) && !wanted.includes(got))) return -1;
    score += 4;
  }
  for (const key of discriminators) {
    const wanted = values(expected, key);
    if (wanted === undefined || wanted === null || wanted === "") continue;
    const got = values(actual, key);
    if (got === undefined || got === null || !sameValue(wanted, got)) return -1;
    score += 2;
  }
  if (expected.quantity != null && sameValue(expected.quantity, actual.quantity)) score += 1;
  if (expected.unit != null && sameValue(expected.unit, actual.unit)) score += 1;
  return score;
}

function possibleDuplicateExtraction(expected: SemanticRecipeLine, actual: SemanticRecipeLine): boolean {
  const discriminators = [
    "semanticKey", "kind", "subtype", "category", "ingredientFamily", "color",
    "stemLengthCm", "format", "hiddenRuleKey", "contextualRuleKey",
  ];
  let compared = 0;
  for (const key of discriminators) {
    const wanted = values(expected, key);
    if (wanted === undefined || wanted === null || wanted === "") continue;
    compared++;
    const got = values(actual, key);
    if (got === undefined || got === null || !sameValue(wanted, got)) return false;
  }
  if (compared > 0) return true;
  const wantedPhrase = normalized(expected.phrase);
  const actualPhrase = normalized(actual.phrase);
  return wantedPhrase.length > 0
    && (actualPhrase.includes(wantedPhrase) || wantedPhrase.includes(actualPhrase));
}

function actualSemanticLines(suggestion: RecipeSuggestion): ActualSemanticLine[] {
  return suggestion.requirements.map((requirement) => {
    const selected = suggestion.lines.find((line) => line.requirementId === requirement.requirementId);
    const attributes = requirement.attributes ?? {};
    return {
      requirement,
      requirementId: requirement.requirementId,
      kind: requirement.kind,
      subtype: requirement.subtype,
      category: requirement.category,
      phrase: requirement.phrase,
      sourceField: requirement.evidence.sourceField,
      sourceOccurrence: requirement.evidence.occurrence,
      sourceSpanStart: requirement.evidence.span.start,
      sourceSpanEnd: requirement.evidence.span.end,
      semanticKey: typeof attributes.semanticKey === "string" ? attributes.semanticKey : undefined,
      ingredientFamily: attributes.ingredientFamily as string | undefined,
      color: attributes.color as string | undefined,
      stemLengthCm: attributes.stemLengthCm as number | undefined,
      format: attributes.format as CanonicalProductFormat | undefined,
      quantity: requirement.quantity,
      unit: requirement.unit,
      preCompatibilityCandidateBaseItemIds: requirement.preCompatibilityCandidateBaseItemIds,
      candidateBaseItemIds: requirement.candidateBaseItemIds,
      selectedBaseItemId: selected?.baseItemId,
      selectedRequirementProvenance: selected?.requirementProvenance,
      baseItemId: selected?.baseItemId,
      hiddenRuleKey: selected?.hiddenRuleKey,
      contextualRuleKey: suggestion.contextualRuleDiagnostics?.find(
        (item) => item.requirementId === requirement.requirementId && item.outcome === "applied",
      )?.ruleKey ?? null,
      provenance: selected?.requirementProvenance ? { evidence: selected.requirementProvenance.evidence } : null,
    };
  });
}

type FinalLineLineageIssue = {
  product_id: number;
  base_item_id: number;
  requirement_id: string | null;
  reason: string;
};

type FinalLineLineageAudit = {
  unsupported_final_lines: FinalLineLineageIssue[];
  dangling_requirement_lines: FinalLineLineageIssue[];
  missing_or_invalid_requirement_provenance: FinalLineLineageIssue[];
};

function requirementIdentity(requirement: RecipeRequirement) {
  return {
    requirementId: requirement.requirementId,
    kind: requirement.kind,
    subtype: requirement.subtype ?? null,
    category: requirement.category ?? null,
    phrase: requirement.phrase,
    quantity: requirement.quantity,
    unit: requirement.unit ?? null,
    attributes: requirement.attributes,
    evidence: requirement.evidence,
    additionalEvidence: requirement.additionalEvidence ?? [],
  };
}

function requirementProvenanceValid(
  requirement: RecipeRequirement,
  attached: RecipeRequirement | null | undefined,
): boolean {
  if (!attached || attached.requirementId !== requirement.requirementId) return false;
  return deterministicRecipeFingerprint(requirementIdentity(attached))
    === deterministicRecipeFingerprint(requirementIdentity(requirement));
}

function auditFinalLineLineage(record: RecipeBenchmarkRecord): FinalLineLineageAudit {
  const audit: FinalLineLineageAudit = {
    unsupported_final_lines: [],
    dangling_requirement_lines: [],
    missing_or_invalid_requirement_provenance: [],
  };
  const requirements = new Map(record.suggestion.requirements.map((item) => [item.requirementId, item]));
  for (const line of record.suggestion.lines) {
    const requirementId = typeof line.requirementId === "string" && line.requirementId.length > 0
      ? line.requirementId
      : null;
    if (requirementId == null && isGovernedOperationalHiddenRuleKey(line.hiddenRuleKey)) continue;
    const issue = {
      product_id: record.product.id,
      base_item_id: line.baseItemId,
      requirement_id: requirementId,
    };
    if (requirementId == null) {
      audit.unsupported_final_lines.push({ ...issue, reason: "missing_requirement_id" });
      continue;
    }
    const requirement = requirements.get(requirementId);
    if (!requirement) {
      audit.dangling_requirement_lines.push({ ...issue, reason: "requirement_id_not_found" });
      continue;
    }
    if (!requirementProvenanceValid(requirement, line.requirementProvenance)) {
      audit.missing_or_invalid_requirement_provenance.push({
        ...issue,
        reason: line.requirementProvenance == null
          ? "missing_requirement_provenance"
          : "stale_or_mismatched_requirement_provenance",
      });
    }
  }
  return audit;
}

function lineageAuditPassed(audit: FinalLineLineageAudit): boolean {
  return audit.unsupported_final_lines.length === 0
    && audit.dangling_requirement_lines.length === 0
    && audit.missing_or_invalid_requirement_provenance.length === 0;
}

function provenanceValid(actual: ActualSemanticLine): boolean {
  const line = actual.requirement;
  const evidence = line.evidence;
  const attached = actual.selectedRequirementProvenance;
  if (!evidence || !line.requirementId || !requirementProvenanceValid(line, attached)) return false;
  return deterministicRecipeFingerprint(attached!.evidence) === deterministicRecipeFingerprint(evidence)
    && evidence.span.start >= 0 && evidence.span.end >= evidence.span.start
    && evidence.exactPhrase.trim().length > 0
    && evidence.normalizedPhrase.trim().length > 0;
}

/** Maximum-weight one-to-one alignment. IDs are reported, never used as semantics. */
export function alignRecipeSemantics(
  suggestion: RecipeSuggestion,
  variant: RecipeAcceptableVariant,
): SemanticAlignment {
  const expected = variant.lines ?? variant.requirements ?? [];
  const actual = actualSemanticLines(suggestion);
  let bestScore = -Infinity;
  let optimalCount = 0;
  let best: Array<[number, number]> = [];
  const visit = (index: number, used: Set<number>, pairs: Array<[number, number]>, score: number) => {
    if (index === expected.length) {
      if (score > bestScore) {
        bestScore = score;
        optimalCount = 1;
        best = [...pairs];
      } else if (score === bestScore) optimalCount++;
      return;
    }
    visit(index + 1, used, pairs, score);
    for (let j = 0; j < actual.length; j++) {
      if (used.has(j)) continue;
      const compatibility = semanticCompatibility(expected[index], actual[j]);
      if (compatibility < 0) continue;
      used.add(j);
      pairs.push([index, j]);
      visit(index + 1, used, pairs, score + 100 + compatibility);
      pairs.pop();
      used.delete(j);
    }
  };
  visit(0, new Set(), [], 0);

  let retrievalEvaluated = 0;
  let retrievalCorrect = 0;
  let compatibilityEvaluated = 0;
  let compatibilityCorrect = 0;
  let allowedSurvivalEvaluated = 0;
  let allowedSurvivalCorrect = 0;
  let incompatibleExclusionEvaluated = 0;
  let incompatibleExclusionCorrect = 0;
  let unknownSurvivalEvaluated = 0;
  let unknownSurvivalCorrect = 0;
  let resolutionCorrect = 0;
  let resolutionEvaluated = 0;
  let quantityEvaluated = 0;
  let quantityCorrect = 0;
  let provenanceCorrect = 0;
  for (const [i, j] of best) {
    const gold = expected[i];
    const got = actual[j];
    const acceptable = gold.acceptableBaseItemIds ?? (gold.baseItemId == null ? [] : [gold.baseItemId]);
    const retrievalRelevant = gold.retrievalRelevantBaseItemIds ?? acceptable;
    if (retrievalRelevant.length) {
      retrievalEvaluated++;
      if (retrievalRelevant.some((id) => got.preCompatibilityCandidateBaseItemIds?.includes(id))) retrievalCorrect++;
    }
    if (acceptable.length) {
      for (const id of acceptable.filter((candidateId) =>
        got.preCompatibilityCandidateBaseItemIds?.includes(candidateId))) {
        compatibilityEvaluated++;
        allowedSurvivalEvaluated++;
        const diagnostic = got.requirement.candidateCompatibility?.find(({ baseItemId }) => baseItemId === id);
        if (diagnostic?.survivor ?? got.candidateBaseItemIds?.includes(id)) {
          compatibilityCorrect++;
          allowedSurvivalCorrect++;
        }
      }
    }
    for (const id of gold.knownIncompatibleBaseItemIds ?? []) {
      if (!got.preCompatibilityCandidateBaseItemIds?.includes(id)) continue;
      compatibilityEvaluated++;
      incompatibleExclusionEvaluated++;
      const diagnostic = got.requirement.candidateCompatibility?.find(({ baseItemId }) => baseItemId === id);
      if (diagnostic && !diagnostic.survivor && diagnostic.hardExclusions.length > 0) {
        compatibilityCorrect++;
        incompatibleExclusionCorrect++;
      }
    }
    for (const id of gold.knownUnknownBaseItemIds ?? []) {
      if (!got.preCompatibilityCandidateBaseItemIds?.includes(id)) continue;
      compatibilityEvaluated++;
      unknownSurvivalEvaluated++;
      const diagnostic = got.requirement.candidateCompatibility?.find(({ baseItemId }) => baseItemId === id);
      if (diagnostic?.survivor && diagnostic.hasUnknownExplicitDiscriminator) {
        compatibilityCorrect++;
        unknownSurvivalCorrect++;
      }
    }
    if (gold.quantity != null) {
      quantityEvaluated++;
      if (sameValue(gold.quantity, got.quantity) && (gold.unit == null || sameValue(gold.unit, got.unit))) quantityCorrect++;
    }
    if (provenanceValid(got)) provenanceCorrect++;
    const expectedOutcome = gold.expectedResolutionOutcome;
    if (expectedOutcome != null || acceptable.length > 0) {
      resolutionEvaluated++;
      const requirementResolved = expectedOutcome === "no_match"
        ? got.requirement.resolution === "no_match" && got.selectedBaseItemId == null
        : expectedOutcome === "ambiguous"
          ? got.requirement.resolution === "ambiguous" && got.selectedBaseItemId == null
          : got.requirement.resolution === "matched"
            && got.selectedBaseItemId != null
            && acceptable.includes(got.selectedBaseItemId);
      if (requirementResolved) resolutionCorrect++;
    }
  }
  const alignmentAmbiguous = optimalCount > 1;
  if (alignmentAmbiguous) {
    return {
      variant_id: variant.id ?? null,
      variant_index: null,
      pairs: best.map(([i, j]) => ({
        expected_index: i, actual_index: j, expected_id: expected[i].id ?? null,
        actual_id: actual[j].requirementId ?? null,
      })),
      unmatched_expected: expected.map((_, i) => i).filter((i) => !best.some(([x]) => x === i)),
      unmatched_actual: actual.map((_, i) => i).filter((i) => !best.some(([, x]) => x === i)),
      ambiguous: true,
      optimal_alignment_count: optimalCount,
      candidate_retrieval: countMetric(0, 0),
      compatibility: countMetric(0, 0),
      compatibility_breakdown: {
        allowed_survival: countMetric(0, 0),
        known_incompatible_exclusion: countMetric(0, 0),
        expected_unknown_survival: countMetric(0, 0),
      },
      resolution: countMetric(0, 0),
      quantity: countMetric(0, 0),
      provenance_integrity: countMetric(0, 0),
    };
  }
  return {
    variant_id: variant.id ?? null,
    variant_index: null,
    pairs: best.map(([i, j]) => ({
      expected_index: i, actual_index: j, expected_id: expected[i].id ?? null,
      actual_id: actual[j].requirementId ?? null,
    })),
    unmatched_expected: expected.map((_, i) => i).filter((i) => !best.some(([x]) => x === i)),
    unmatched_actual: actual.map((_, i) => i).filter((i) => !best.some(([, x]) => x === i)),
    ambiguous: alignmentAmbiguous,
    optimal_alignment_count: optimalCount,
    candidate_retrieval: countMetric(retrievalEvaluated, retrievalCorrect),
    compatibility: countMetric(compatibilityEvaluated, compatibilityCorrect),
    compatibility_breakdown: {
      allowed_survival: countMetric(allowedSurvivalEvaluated, allowedSurvivalCorrect),
      known_incompatible_exclusion: countMetric(incompatibleExclusionEvaluated, incompatibleExclusionCorrect),
      expected_unknown_survival: countMetric(unknownSurvivalEvaluated, unknownSurvivalCorrect),
    },
    resolution: countMetric(resolutionEvaluated, resolutionCorrect),
    quantity: countMetric(quantityEvaluated, quantityCorrect),
    provenance_integrity: countMetric(best.length, provenanceCorrect),
  };
}

function variants(annotation?: StructuredRecipeAnnotation): RecipeAcceptableVariant[] {
  return annotation?.finalRecipe?.acceptableVariants ?? annotation?.acceptableVariants ?? [];
}

function semanticLineScoringProjection(line: SemanticRecipeLine) {
  return {
    kind: line.kind ?? null,
    subtype: line.subtype ?? null,
    category: line.category ?? null,
    phrase: String(line.phrase ?? "").trim().toLowerCase().replace(/\s+/g, " "),
    sourceField: line.sourceField ?? null,
    sourceOccurrence: line.sourceOccurrence ?? null,
    sourceSpanStart: line.sourceSpanStart ?? null,
    sourceSpanEnd: line.sourceSpanEnd ?? null,
    semanticKey: line.semanticKey ?? null,
    ingredientFamily: line.ingredientFamily ?? null,
    color: line.color ?? null,
    stemLengthCm: line.stemLengthCm ?? null,
    format: line.format ?? null,
    quantity: line.quantity ?? null,
    unit: line.unit ?? null,
    baseItemId: line.baseItemId ?? null,
    acceptableBaseItemIds: [...(line.acceptableBaseItemIds ?? [])].sort((a, b) => a - b),
    retrievalRelevantBaseItemIds: [...(line.retrievalRelevantBaseItemIds ?? [])].sort((a, b) => a - b),
    knownIncompatibleBaseItemIds: [...(line.knownIncompatibleBaseItemIds ?? [])].sort((a, b) => a - b),
    knownUnknownBaseItemIds: [...(line.knownUnknownBaseItemIds ?? [])].sort((a, b) => a - b),
    hiddenRuleKey: line.hiddenRuleKey ?? null,
    contextualRuleKey: line.contextualRuleKey ?? null,
    expectedResolutionOutcome: line.expectedResolutionOutcome ?? null,
  };
}

export function recipeBenchmarkAnnotationScoringProjection(annotation: StructuredRecipeAnnotation) {
  const projectHiddenRules = (expectations: StructuredRecipeAnnotation["hiddenRules"] | undefined) =>
    expectations?.map((expectation) => ({
      ruleKey: expectation.ruleKey,
      expected: expectation.expected,
      expectedCount: hiddenRuleExpectedCount(expectation),
      acceptableBaseItemIds: [...(expectation.acceptableBaseItemIds ?? [])].sort((a, b) => a - b),
    })).sort((a, b) =>
      deterministicRecipeFingerprint(a).localeCompare(deterministicRecipeFingerprint(b))) ?? null;
  const projectedVariants = variants(annotation).map((variant) => ({
    disposition: variant.disposition ?? null,
    lines: (variant.lines ?? variant.requirements ?? []).map(semanticLineScoringProjection)
      .sort((a, b) => deterministicRecipeFingerprint(a).localeCompare(deterministicRecipeFingerprint(b))),
    hidden_rules: projectHiddenRules(variant.hiddenRules ?? annotation.hiddenRules),
  })).sort((a, b) =>
    deterministicRecipeFingerprint(a).localeCompare(deterministicRecipeFingerprint(b)));
  return {
    expected: annotation.expected ?? null,
    final_recipe_disposition: annotation.finalRecipe?.disposition ?? null,
    acceptable_variants: projectedVariants,
    format_expectation: annotation.formatExpectation ?? null,
    contextual_resolvers: [...(annotation.contextualResolvers ?? [])]
      .sort((a, b) => deterministicRecipeFingerprint(a).localeCompare(deterministicRecipeFingerprint(b))),
    hidden_rules: projectHiddenRules(annotation.hiddenRules),
  };
}

function bestAlignment(
  suggestion: RecipeSuggestion,
  annotation: StructuredRecipeAnnotation | undefined,
): SemanticAlignment | null {
  const candidates = variants(annotation).map((variant, index) => {
    const alignment = {
      ...alignRecipeSemantics(suggestion, variant),
      variant_index: index,
    };
    const hidden = hiddenRuleExactness(suggestion, variant.hiddenRules ?? annotation?.hiddenRules);
    const eligible = variantHasDefinitiveExactness(annotation, variant);
    return { alignment, hidden, eligible };
  });
  const ratio = (metric: CountMetric) =>
    metric.evaluated === 0 ? 1 : metric.correct / metric.evaluated;
  const score = ({ alignment, hidden, eligible }: typeof candidates[number]) => [
    alignment.pairs.length,
    -alignment.unmatched_expected.length,
    -alignment.unmatched_actual.length,
    alignment.ambiguous ? 0 : 1,
    ratio(alignment.resolution),
    ratio(alignment.quantity),
    ratio(alignment.compatibility),
    ratio(alignment.candidate_retrieval),
    ratio(alignment.provenance_integrity),
    eligible ? 1 : 0,
    hidden === true ? 1 : hidden === false ? 0 : -1,
  ];
  const compareScore = (left: number[], right: number[]) => {
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return 0;
  };
  candidates.sort((left, right) => compareScore(score(left), score(right)));
  const selected = candidates[0];
  if (!selected) return null;
  const tied = candidates.filter((candidate) => compareScore(score(selected), score(candidate)) === 0);
  if (tied.length === 1) return selected.alignment;
  return {
    ...selected.alignment,
    variant_id: null,
    variant_index: null,
    ambiguous: true,
    optimal_alignment_count: tied.reduce((sum, candidate) =>
      sum + candidate.alignment.optimal_alignment_count, 0),
    candidate_retrieval: countMetric(0, 0),
    compatibility: countMetric(0, 0),
    compatibility_breakdown: {
      allowed_survival: countMetric(0, 0),
      known_incompatible_exclusion: countMetric(0, 0),
      expected_unknown_survival: countMetric(0, 0),
    },
    resolution: countMetric(0, 0),
    quantity: countMetric(0, 0),
    provenance_integrity: countMetric(0, 0),
  };
}

function fullRecipeExact(comparison: RecipeComparison): boolean {
  return comparison.missingItems.length === 0 && comparison.incorrectExtras.length === 0
    && comparison.baseItem.expectedCount === comparison.baseItem.matchedCount
    && comparison.quantity.comparedCount === comparison.quantity.correctCount;
}
function hasAmbiguousResult(suggestion: RecipeSuggestion): boolean {
  return suggestion.conflicts.length > 0 || suggestion.requirements.some(({ resolution }) => resolution === "ambiguous");
}
function metricAdd(target: { evaluated: number; correct: number }, metric: CountMetric) {
  target.evaluated += metric.evaluated;
  target.correct += metric.correct;
}

type RequirementFailureStage =
  | "extraction_failure"
  | "candidate_retrieval_failure"
  | "compatibility_exclusion_failure"
  | "unknown_evidence_withholding"
  | "genuine_compatible_ambiguity"
  | "contextual_resolution_failure"
  | "base_item_resolution_failure"
  | "quantity_failure"
  | "provenance_failure";

function selectedVariant(
  annotation: StructuredRecipeAnnotation | undefined,
  alignment: SemanticAlignment,
): RecipeAcceptableVariant | null {
  const choices = variants(annotation);
  return alignment.variant_index == null ? null : choices[alignment.variant_index] ?? null;
}

function resolutionExpectationDefined(line: SemanticRecipeLine): boolean {
  return line.expectedResolutionOutcome != null
    || (line.acceptableBaseItemIds?.length ?? 0) > 0
    || line.baseItemId != null;
}

type HiddenRuleExpectation = NonNullable<StructuredRecipeAnnotation["hiddenRules"]>[number];

function hiddenRuleExpectedCount(expectation: HiddenRuleExpectation): number {
  return expectation.expectedCount ?? (expectation.expected ? 1 : 0);
}

function hiddenRuleExpectationIsDefinitive(expectation: HiddenRuleExpectation): boolean {
  const expectedCount = hiddenRuleExpectedCount(expectation);
  return Number.isInteger(expectedCount)
    && expectedCount >= 0
    && expectation.expected === (expectedCount > 0)
    && (expectedCount === 0 || (expectation.acceptableBaseItemIds?.length ?? 0) > 0);
}

function hiddenRuleExactness(
  suggestion: RecipeSuggestion,
  expectations: StructuredRecipeAnnotation["hiddenRules"] | undefined,
): boolean | null {
  if (expectations === undefined) return null;
  const actualHidden = suggestion.lines.filter((line) => line.hiddenRuleKey != null);
  for (const expectation of expectations) {
    if (!hiddenRuleExpectationIsDefinitive(expectation)) return null;
    const expectedCount = hiddenRuleExpectedCount(expectation);
    const matching = actualHidden.filter((line) =>
      operationalRuleMatches(expectation.ruleKey, line.hiddenRuleKey));
    if (
      matching.length !== expectedCount
      || (expectedCount > 0
        && matching.some((line) => !expectation.acceptableBaseItemIds!.includes(line.baseItemId)))
    ) {
      return false;
    }
  }
  if (actualHidden.some((line) => !expectations.some((expectation) =>
    operationalRuleMatches(expectation.ruleKey, line.hiddenRuleKey)))) return false;
  return true;
}

function variantHasDefinitiveExactness(
  annotation: StructuredRecipeAnnotation | undefined,
  variant: RecipeAcceptableVariant,
): boolean {
  const disposition = variant.disposition ?? annotation?.finalRecipe?.disposition;
  const hiddenRules = variant.hiddenRules ?? annotation?.hiddenRules;
  return disposition !== "partial_catalog_coverage"
    && expectedLines(variant).every(resolutionExpectationDefined)
    && hiddenRules !== undefined
    && hiddenRules.every(hiddenRuleExpectationIsDefinitive);
}

function annotationHasDefinitiveExactness(annotation: StructuredRecipeAnnotation | undefined): boolean {
  if (!annotation) return false;
  return variants(annotation).some((variant) => variantHasDefinitiveExactness(annotation, variant));
}

type FailedGenerationSemanticConsensus = {
  requirements: Array<{
    representative: SemanticRecipeLine;
  }>;
  positiveBaseItemRequirementCount: number;
  expectedAmbiguousRequirementCount: number;
  expectedNoMatchRequirementCount: number;
  undefinedBaseItemGoldRequirementCount: number;
  variantSpecificRequirementCount: number;
};

const SEMANTIC_REQUIREMENT_IDENTITY_FIELDS = [
  "sourceField", "sourceOccurrence", "sourceSpanStart", "sourceSpanEnd",
  "semanticKey", "kind", "subtype", "category", "ingredientFamily", "color",
  "stemLengthCm", "format",
] as const;

function semanticRequirementIdentityCompatible(
  left: SemanticRecipeLine,
  right: SemanticRecipeLine,
): boolean {
  let sharedIdentity = false;
  for (const key of SEMANTIC_REQUIREMENT_IDENTITY_FIELDS) {
    const leftValue = values(left, key);
    const rightValue = values(right, key);
    const leftPresent = leftValue !== undefined && leftValue !== null && leftValue !== "";
    const rightPresent = rightValue !== undefined && rightValue !== null && rightValue !== "";
    if (!leftPresent || !rightPresent) continue;
    if (!sameValue(leftValue, rightValue)) return false;
    sharedIdentity = true;
  }
  const leftPhrase = normalized(left.phrase);
  const rightPhrase = normalized(right.phrase);
  if (leftPhrase && rightPhrase) {
    if (!sameValue(leftPhrase, rightPhrase)) return false;
    sharedIdentity = true;
  }
  return sharedIdentity;
}

function semanticRequirementIdentityProjection(line: SemanticRecipeLine) {
  return Object.fromEntries([
    ...SEMANTIC_REQUIREMENT_IDENTITY_FIELDS.map((key) => {
      const value = values(line, key);
      return [key, typeof value === "string" ? normalized(value) || null : value ?? null];
    }),
    ["phrase", normalized(line.phrase) || null],
  ]);
}

type SemanticIdentityGroup = {
  fingerprint: string;
  representative: SemanticRecipeLine;
  lines: SemanticRecipeLine[];
};

function semanticIdentityGroups(lines: SemanticRecipeLine[]): SemanticIdentityGroup[] {
  const grouped = new Map<string, SemanticIdentityGroup>();
  for (const line of lines) {
    const fingerprint = deterministicRecipeFingerprint(
      semanticRequirementIdentityProjection(line),
    );
    const existing = grouped.get(fingerprint);
    if (existing) existing.lines.push(line);
    else grouped.set(fingerprint, { fingerprint, representative: line, lines: [line] });
  }
  return [...grouped.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint));
}

function variantSemanticIdentityFingerprint(variant: RecipeAcceptableVariant): string {
  return deterministicRecipeFingerprint(
    semanticIdentityGroups(expectedLines(variant))
      .map(({ fingerprint, lines }) => ({ fingerprint, count: lines.length })),
  );
}

function baseItemOutcomeCounts(lines: SemanticRecipeLine[]) {
  const acceptableIds = (line: SemanticRecipeLine) =>
    line.acceptableBaseItemIds ?? (line.baseItemId == null ? [] : [line.baseItemId]);
  return {
    positive: lines.filter((line) =>
      acceptableIds(line).length > 0
      && line.expectedResolutionOutcome !== "ambiguous"
      && line.expectedResolutionOutcome !== "no_match").length,
    ambiguous: lines.filter((line) =>
      line.expectedResolutionOutcome === "ambiguous").length,
    noMatch: lines.filter((line) =>
      line.expectedResolutionOutcome === "no_match").length,
    undefinedGold: lines.filter((line) =>
      acceptableIds(line).length === 0 && line.expectedResolutionOutcome == null).length,
  };
}

function failedGenerationSemanticConsensus(
  annotation: StructuredRecipeAnnotation | undefined,
): FailedGenerationSemanticConsensus {
  const choices = [...variants(annotation)].sort((left, right) =>
    variantSemanticIdentityFingerprint(left).localeCompare(
      variantSemanticIdentityFingerprint(right),
    ));
  if (choices.length === 0) {
    return {
      requirements: [],
      positiveBaseItemRequirementCount: 0,
      expectedAmbiguousRequirementCount: 0,
      expectedNoMatchRequirementCount: 0,
      undefinedBaseItemGoldRequirementCount: 0,
      variantSpecificRequirementCount: 0,
    };
  }
  let consensus = semanticIdentityGroups(expectedLines(choices[0])).map((group) => ({
    representative: group.representative,
    accumulatedIdentity: [group.representative],
    extractionCount: group.lines.length,
    outcomeCounts: [baseItemOutcomeCounts(group.lines)],
  }));
  for (const choice of choices.slice(1)) {
    const candidates = semanticIdentityGroups(expectedLines(choice));
    const compatibleCandidates = consensus.map(({ accumulatedIdentity }) =>
      candidates.map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(({ candidate }) => accumulatedIdentity.every((existing) =>
          semanticRequirementIdentityCompatible(existing, candidate.representative)))
        .map(({ candidateIndex }) => candidateIndex));
    const compatibleConsensus = candidates.map((_, candidateIndex) =>
      compatibleCandidates
        .map((candidateIndexes, consensusIndex) => ({ candidateIndexes, consensusIndex }))
        .filter(({ candidateIndexes }) => candidateIndexes.includes(candidateIndex))
        .map(({ consensusIndex }) => consensusIndex));
    consensus = consensus.flatMap((item, consensusIndex) => {
      const candidateIndexes = compatibleCandidates[consensusIndex];
      if (candidateIndexes.length !== 1) return [];
      const candidateIndex = candidateIndexes[0];
      if (compatibleConsensus[candidateIndex].length !== 1) return [];
      const candidate = candidates[candidateIndex];
      return [{
        ...item,
        accumulatedIdentity: [...item.accumulatedIdentity, candidate.representative],
        extractionCount: Math.min(item.extractionCount, candidate.lines.length),
        outcomeCounts: [...item.outcomeCounts, baseItemOutcomeCounts(candidate.lines)],
      }];
    });
  }
  const totalRequirements = choices.reduce((sum, choice) => sum + expectedLines(choice).length, 0);
  const extractionCount = consensus.reduce((sum, item) => sum + item.extractionCount, 0);
  const guaranteedOutcomeCount = (
    key: keyof ReturnType<typeof baseItemOutcomeCounts>,
  ) => consensus.reduce((sum, item) =>
    sum + Math.min(item.extractionCount, ...item.outcomeCounts.map((counts) => counts[key])), 0);
  return {
    requirements: consensus.flatMap(({ representative, extractionCount: count }) =>
      Array.from({ length: count }, () => ({ representative }))),
    positiveBaseItemRequirementCount: guaranteedOutcomeCount("positive"),
    expectedAmbiguousRequirementCount: guaranteedOutcomeCount("ambiguous"),
    expectedNoMatchRequirementCount: guaranteedOutcomeCount("noMatch"),
    undefinedBaseItemGoldRequirementCount: guaranteedOutcomeCount("undefinedGold"),
    variantSpecificRequirementCount:
      totalRequirements - extractionCount * choices.length,
  };
}

function semanticExactness(
  record: RecipeBenchmarkRecord,
  alignment: SemanticAlignment,
): boolean | null {
  if (alignment.ambiguous || !annotationHasDefinitiveExactness(record.annotation)) return null;
  const variant = selectedVariant(record.annotation, alignment);
  if (!variant || !variantHasDefinitiveExactness(record.annotation, variant)) return null;
  if (!lineageAuditPassed(auditFinalLineLineage(record))) return false;
  const hidden = hiddenRuleExactness(
    record.suggestion,
    variant.hiddenRules ?? record.annotation?.hiddenRules,
  );
  if (hidden == null) return null;
  return hidden
    && alignment.unmatched_expected.length === 0
    && alignment.unmatched_actual.length === 0
    && alignment.resolution.evaluated === expectedLines(variant).length
    && alignment.resolution.correct === alignment.resolution.evaluated
    && alignment.quantity.correct === alignment.quantity.evaluated;
}

function baseItemResolutionForRecord(
  record: RecipeBenchmarkRecord,
  alignment: SemanticAlignment | null,
) {
  const empty = {
    product_id: record.product.id,
    scored: false,
    unscored_reason: alignment?.ambiguous
      ? "semantic_alignment_ambiguous"
      : "no_unambiguous_acceptable_variant",
    definitive_positive_gold_requirements: 0,
    resolved_semantic_predictions: 0,
    correctly_resolved_allowed_base_item_matches: 0,
    incorrectly_resolved_semantic_lines: 0,
    false_positive_resolved_semantic_lines: 0,
    missed_or_unresolved_positive_requirements: 0,
    ambiguous_outcomes: 0,
    no_match_outcomes: 0,
    expected_ambiguous_outcomes_excluded: 0,
    expected_no_match_outcomes_excluded: 0,
    undefined_base_item_gold_requirements_unscored: 0,
    precision: null as number | null,
    recall: null as number | null,
    f1: null as number | null,
  };
  const generationUnavailable =
    record.generationStatus === "failed" || record.generationStatus === "unsupported";
  if ((!generationUnavailable && !alignment) || alignment?.ambiguous) return empty;
  if (generationUnavailable) {
    const consensus = failedGenerationSemanticConsensus(record.annotation);
    const positive = consensus.positiveBaseItemRequirementCount;
    const expectedAmbiguous = consensus.expectedAmbiguousRequirementCount;
    const expectedNoMatch = consensus.expectedNoMatchRequirementCount;
    const undefinedGold = consensus.undefinedBaseItemGoldRequirementCount;
    if (positive === 0) {
      return {
        ...empty,
        unscored_reason: "no_definitive_positive_base_item_gold",
        expected_ambiguous_outcomes_excluded: expectedAmbiguous,
        expected_no_match_outcomes_excluded: expectedNoMatch,
        undefined_base_item_gold_requirements_unscored: undefinedGold,
      };
    }
    return {
      ...empty,
      scored: true,
      unscored_reason: null,
      definitive_positive_gold_requirements: positive,
      missed_or_unresolved_positive_requirements: positive,
      expected_ambiguous_outcomes_excluded: expectedAmbiguous,
      expected_no_match_outcomes_excluded: expectedNoMatch,
      undefined_base_item_gold_requirements_unscored: undefinedGold,
      recall: 0,
      f1: 0,
    };
  }
  const variant = selectedVariant(record.annotation, alignment!);
  if (!variant) return empty;
  const gold = expectedLines(variant);
  const positiveIndexes = gold.map((line, index) => ({ line, index })).filter(({ line }) => {
    const acceptable = line.acceptableBaseItemIds ?? (line.baseItemId == null ? [] : [line.baseItemId]);
    return acceptable.length > 0
      && line.expectedResolutionOutcome !== "ambiguous"
      && line.expectedResolutionOutcome !== "no_match";
  });
  const expectedAmbiguous = gold.filter((line) => line.expectedResolutionOutcome === "ambiguous").length;
  const expectedNoMatch = gold.filter((line) => line.expectedResolutionOutcome === "no_match").length;
  const undefinedGold = gold.filter((line) => {
    const acceptable = line.acceptableBaseItemIds ?? (line.baseItemId == null ? [] : [line.baseItemId]);
    return acceptable.length === 0 && line.expectedResolutionOutcome == null;
  }).length;
  if (positiveIndexes.length === 0) {
    return {
      ...empty,
      unscored_reason: "no_definitive_positive_base_item_gold",
      expected_ambiguous_outcomes_excluded: expectedAmbiguous,
      expected_no_match_outcomes_excluded: expectedNoMatch,
      undefined_base_item_gold_requirements_unscored: undefinedGold,
    };
  }
  const actual = actualSemanticLines(record.suggestion);
  const scoredAlignment = alignment!;
  const pairByExpected = new Map(scoredAlignment.pairs.map((pair) => [pair.expected_index, pair]));
  const pairedNonPositiveRequirementIds = new Set(scoredAlignment.pairs
    .filter((pair) => !positiveIndexes.some(({ index }) => index === pair.expected_index))
    .map((pair) => actual[pair.actual_index]?.requirementId)
    .filter((id): id is string => id != null));
  const requirements = new Map(record.suggestion.requirements.map((item) => [item.requirementId, item]));
  const validSemanticLines = record.suggestion.lines.filter((line) => {
    if (isGovernedOperationalHiddenRuleKey(line.hiddenRuleKey)) return false;
    const requirement = typeof line.requirementId === "string"
      ? requirements.get(line.requirementId)
      : undefined;
    return requirement != null && requirementProvenanceValid(requirement, line.requirementProvenance);
  });
  const positiveRequirementIds = new Set<string>();
  let correct = 0;
  let incorrect = 0;
  let missed = 0;
  let ambiguous = 0;
  let noMatch = 0;
  let resolved = 0;
  for (const { line, index } of positiveIndexes) {
    const pair = pairByExpected.get(index);
    if (!pair) {
      missed++;
      continue;
    }
    const requirement = actual[pair.actual_index]?.requirement;
    if (!requirement) {
      missed++;
      continue;
    }
    positiveRequirementIds.add(requirement.requirementId);
    if (requirement.resolution === "ambiguous") ambiguous++;
    if (requirement.resolution === "no_match") noMatch++;
    const predictions = validSemanticLines.filter((candidate) =>
      candidate.requirementId === requirement.requirementId);
    resolved += predictions.length;
    if (predictions.length === 0) {
      missed++;
      continue;
    }
    const acceptable = line.acceptableBaseItemIds ?? (line.baseItemId == null ? [] : [line.baseItemId]);
    const correctPrediction = predictions.find((candidate) => acceptable.includes(candidate.baseItemId));
    if (correctPrediction) {
      correct++;
      incorrect += predictions.length - 1;
    } else {
      incorrect += predictions.length;
    }
  }
  const falsePositive = validSemanticLines.filter((line) =>
    !positiveRequirementIds.has(line.requirementId!)
    && !pairedNonPositiveRequirementIds.has(line.requirementId!)).length;
  resolved += falsePositive;
  incorrect += falsePositive;
  const precision = resolved === 0 ? null : round(correct / resolved);
  const recall = round(correct / positiveIndexes.length);
  const f1 = precision == null
    ? 0
    : precision + recall === 0 ? 0 : round((2 * precision * recall) / (precision + recall));
  return {
    product_id: record.product.id,
    scored: true,
    unscored_reason: null,
    definitive_positive_gold_requirements: positiveIndexes.length,
    resolved_semantic_predictions: resolved,
    correctly_resolved_allowed_base_item_matches: correct,
    incorrectly_resolved_semantic_lines: incorrect,
    false_positive_resolved_semantic_lines: falsePositive,
    missed_or_unresolved_positive_requirements: missed,
    ambiguous_outcomes: ambiguous,
    no_match_outcomes: noMatch,
    expected_ambiguous_outcomes_excluded: expectedAmbiguous,
    expected_no_match_outcomes_excluded: expectedNoMatch,
    undefined_base_item_gold_requirements_unscored: undefinedGold,
    precision,
    recall,
    f1,
  };
}

function expectedLines(variant: RecipeAcceptableVariant | null): SemanticRecipeLine[] {
  return variant?.lines ?? variant?.requirements ?? [];
}

function requirementIdentifier(line: SemanticRecipeLine, index: number): string {
  return line.id ?? line.requirementId ?? line.semanticKey ?? `expected:${index}`;
}

function operationalRuleMatches(expectedRuleKey: string, actualRuleKey: string | null): boolean {
  if (expectedRuleKey === "flower_box_sponge") {
    return actualRuleKey != null && /^flower_box_(round|heart)_.+_sponge$/.test(actualRuleKey);
  }
  return expectedRuleKey === actualRuleKey;
}

function failureStageForPair(
  record: RecipeBenchmarkRecord,
  expected: SemanticRecipeLine,
  actual: ActualSemanticLine,
): RequirementFailureStage | null {
  const acceptable = expected.acceptableBaseItemIds ?? (expected.baseItemId == null ? [] : [expected.baseItemId]);
  const retrievalRelevant = expected.retrievalRelevantBaseItemIds ?? acceptable;
  const expectedResolution = expected.expectedResolutionOutcome;
  const retrieved = actual.preCompatibilityCandidateBaseItemIds ?? [];
  if (retrievalRelevant.length > 0 && !retrievalRelevant.some((id) => retrieved.includes(id))) {
    return "candidate_retrieval_failure";
  }

  const retrievedAcceptable = acceptable.filter((id) => retrieved.includes(id));
  if (retrievedAcceptable.length > 0) {
    const diagnostics = retrievedAcceptable.map((id) =>
      actual.requirement.candidateCompatibility?.find(({ baseItemId }) => baseItemId === id));
    if (diagnostics.every((diagnostic) =>
      diagnostic != null && !diagnostic.survivor && diagnostic.hardExclusions.length > 0)) {
      return "compatibility_exclusion_failure";
    }
    if (
      actual.requirement.resolution !== "matched"
      && diagnostics.some((diagnostic) => diagnostic?.survivor && diagnostic.hasUnknownExplicitDiscriminator)
    ) {
      return "unknown_evidence_withholding";
    }
  }

  if (actual.requirement.resolution === "ambiguous" && expectedResolution !== "ambiguous") {
    return "genuine_compatible_ambiguity";
  }

  if (expected.contextualRuleKey) {
    const contextual = record.suggestion.contextualRuleDiagnostics?.find((diagnostic) =>
      diagnostic.requirementId === actual.requirementId
      && diagnostic.ruleKey === expected.contextualRuleKey);
    if (contextual?.outcome !== "applied") return "contextual_resolution_failure";
  }

  if (expectedResolution == null && acceptable.length === 0) return null;
  const resolutionCorrect = expectedResolution === "no_match"
    ? actual.requirement.resolution === "no_match" && actual.selectedBaseItemId == null
    : expectedResolution === "ambiguous"
      ? actual.requirement.resolution === "ambiguous" && actual.selectedBaseItemId == null
      : actual.requirement.resolution === "matched"
        && actual.selectedBaseItemId != null
        && acceptable.includes(actual.selectedBaseItemId);
  if (!resolutionCorrect) return "base_item_resolution_failure";

  if (
    expected.quantity != null
    && (!sameValue(expected.quantity, actual.quantity)
      || (expected.unit != null && !sameValue(expected.unit, actual.unit)))
  ) {
    return "quantity_failure";
  }

  if (actual.selectedBaseItemId != null && !provenanceValid(actual)) return "provenance_failure";
  return null;
}

function semanticExtractionForRecord(
  record: RecipeBenchmarkRecord,
  alignment: SemanticAlignment | null,
) {
  const actual = actualSemanticLines(record.suggestion);
  const generationUnavailable =
    record.generationStatus === "failed" || record.generationStatus === "unsupported";
  if (generationUnavailable) {
    const expected = failedGenerationSemanticConsensus(record.annotation)
      .requirements.map(({ representative }) => representative);
    const missing = expected.map(requirementIdentifier);
    return {
      product_id: record.product.id,
      definitive_expected_gold_requirements: expected.length,
      unambiguously_aligned_extracted_requirements: 0,
      missing_gold_requirements: missing,
      unmatched_extracted_requirements: [],
      duplicate_extraction: [],
      ambiguous_alignment: [],
      precision: countMetric(0, 0),
      recall: countMetric(expected.length, 0),
      failure_stages: missing.map((expectedRequirementId) => ({
        product_id: record.product.id,
        expected_requirement_id: expectedRequirementId,
        actual_requirement_id: null,
        stage: "extraction_failure" as const,
      })),
    };
  }
  if (!alignment) {
    return {
      product_id: record.product.id,
      definitive_expected_gold_requirements: 0,
      unambiguously_aligned_extracted_requirements: 0,
      missing_gold_requirements: [],
      unmatched_extracted_requirements: [],
      duplicate_extraction: [],
      ambiguous_alignment: [],
      precision: countMetric(0, 0),
      recall: countMetric(0, 0),
      failure_stages: [] as Array<{
        product_id: number;
        expected_requirement_id: string;
        actual_requirement_id: string | null;
        stage: RequirementFailureStage;
      }>,
    };
  }

  if (alignment.ambiguous) {
    const choices = variants(record.annotation);
    const ambiguityIds = [...new Set(choices.flatMap((choice) =>
      expectedLines(choice).map(requirementIdentifier)))];
    return {
      product_id: record.product.id,
      definitive_expected_gold_requirements: ambiguityIds.length,
      unambiguously_aligned_extracted_requirements: 0,
      missing_gold_requirements: [],
      unmatched_extracted_requirements: [],
      duplicate_extraction: [],
      ambiguous_alignment: ambiguityIds,
      precision: countMetric(0, 0),
      recall: countMetric(0, 0),
      failure_stages: [] as Array<{
        product_id: number;
        expected_requirement_id: string;
        actual_requirement_id: string | null;
        stage: RequirementFailureStage;
      }>,
    };
  }

  const expected = expectedLines(selectedVariant(record.annotation, alignment));
  const matchedExpected = new Set(alignment.pairs.map(({ expected_index }) => expected_index));
  const missing = expected
    .map((line, index) => ({ line, index }))
    .filter(({ index }) => !matchedExpected.has(index))
    .map(({ line, index }) => requirementIdentifier(line, index));
  const unmatchedActual = alignment.unmatched_actual.map((index) => actual[index]?.requirementId ?? null);
  const duplicates = alignment.unmatched_actual
    .filter((actualIndex) => expected.some((line) => possibleDuplicateExtraction(line, actual[actualIndex])))
    .map((index) => actual[index]?.requirementId ?? null);
  const failures: Array<{
    product_id: number;
    expected_requirement_id: string;
    actual_requirement_id: string | null;
    stage: RequirementFailureStage;
  }> = missing.map((expectedRequirementId) => ({
    product_id: record.product.id,
    expected_requirement_id: expectedRequirementId,
    actual_requirement_id: null,
    stage: "extraction_failure",
  }));
  for (const pair of alignment.pairs) {
    const gold = expected[pair.expected_index];
    const got = actual[pair.actual_index];
    const stage = failureStageForPair(record, gold, got);
    if (stage) {
      failures.push({
        product_id: record.product.id,
        expected_requirement_id: requirementIdentifier(gold, pair.expected_index),
        actual_requirement_id: got.requirementId ?? null,
        stage,
      });
    }
  }
  return {
    product_id: record.product.id,
    definitive_expected_gold_requirements: expected.length,
    unambiguously_aligned_extracted_requirements: alignment.pairs.length,
    missing_gold_requirements: missing,
    unmatched_extracted_requirements: unmatchedActual,
    duplicate_extraction: duplicates,
    ambiguous_alignment: [],
    precision: countMetric(alignment.pairs.length + unmatchedActual.length, alignment.pairs.length),
    recall: countMetric(expected.length, alignment.pairs.length),
    failure_stages: failures,
  };
}

function scoreHiddenRules(records: RecipeBenchmarkRecord[]) {
  const totals = { evaluated: 0, correct: 0 };
  const byRule = new Map<string, { evaluated: number; correct: number }>();
  for (const record of records) {
    const alignment = bestAlignment(record.suggestion, record.annotation);
    const variant = alignment && !alignment.ambiguous
      ? selectedVariant(record.annotation, alignment)
      : null;
    const expectations = variant?.hiddenRules ?? record.annotation?.hiddenRules ?? [];
    for (const expectation of expectations) {
      const matchingLines = record.suggestion.lines.filter((line) =>
        operationalRuleMatches(expectation.ruleKey, line.hiddenRuleKey));
      const expectedCount = hiddenRuleExpectedCount(expectation);
      const correct = hiddenRuleExpectationIsDefinitive(expectation)
        && matchingLines.length === expectedCount
        && (expectedCount === 0 || matchingLines.every((line) =>
          expectation.acceptableBaseItemIds!.includes(line.baseItemId)));
      totals.evaluated++;
      if (correct) totals.correct++;
      const bucket = byRule.get(expectation.ruleKey) ?? { evaluated: 0, correct: 0 };
      bucket.evaluated++;
      if (correct) bucket.correct++;
      byRule.set(expectation.ruleKey, bucket);
    }
  }
  return {
    ...countMetric(totals.evaluated, totals.correct),
    by_rule: Object.fromEntries([...byRule].map(([key, metric]) =>
      [key, countMetric(metric.evaluated, metric.correct)])),
  };
}

function scoreFormatAndContext(records: RecipeBenchmarkRecord[]) {
  const format = {
    authoritative: { evaluated: 0, correct: 0 },
    conflict: { evaluated: 0, correct: 0 },
    resolved: { evaluated: 0, correct: 0 },
  };
  const contextual = { evaluated: 0, correct: 0 };
  for (const record of records) {
    const expectation = record.annotation?.formatExpectation;
    if (expectation?.authoritativeProductFormat !== undefined) {
      format.authoritative.evaluated++;
      if (sameValue(
        expectation.authoritativeProductFormat,
        record.suggestion.structure.formatResolution.authoritativePrimaryFormat,
      )) format.authoritative.correct++;
    }
    if (expectation?.conflictExpected !== undefined) {
      format.conflict.evaluated++;
      if (expectation.conflictExpected ===
        (record.suggestion.structure.formatResolution.disagreements.length > 0)) format.conflict.correct++;
    }
    if (expectation?.expectedResolvedPrimaryFormat !== undefined) {
      format.resolved.evaluated++;
      if (sameValue(
        expectation.expectedResolvedPrimaryFormat,
        record.suggestion.structure.formatResolution.resolvedPrimaryFormat,
      )) format.resolved.correct++;
    }
    const alignment = bestAlignment(record.suggestion, record.annotation);
    const variant = alignment && !alignment.ambiguous
      ? selectedVariant(record.annotation, alignment)
      : null;
    const expected = expectedLines(variant);
    for (const resolver of record.annotation?.contextualResolvers ?? []) {
      contextual.evaluated++;
      const expectedIndex = expected.findIndex((line, index) =>
        resolver.requirementId === requirementIdentifier(line, index)
        || (resolver.semanticKey != null && resolver.semanticKey === line.semanticKey));
      const pair = alignment?.pairs.find((candidate) => candidate.expected_index === expectedIndex);
      const actualRequirementId = pair == null
        ? resolver.requirementId
        : actualSemanticLines(record.suggestion)[pair.actual_index]?.requirementId;
      const diagnostic = record.suggestion.contextualRuleDiagnostics?.find((candidate) =>
        candidate.ruleKey === resolver.ruleKey
        && (!actualRequirementId || candidate.requirementId === actualRequirementId));
      if (
        diagnostic?.outcome === resolver.expectedOutcome
        && (resolver.expectedBaseItemId == null || diagnostic.resolverBaseItemId === resolver.expectedBaseItemId)
      ) contextual.correct++;
    }
  }
  return {
    authoritative_product_format: countMetric(format.authoritative.evaluated, format.authoritative.correct),
    format_conflict_handling: countMetric(format.conflict.evaluated, format.conflict.correct),
    resolved_primary_format: countMetric(format.resolved.evaluated, format.resolved.correct),
    contextual_resolver: countMetric(contextual.evaluated, contextual.correct),
  };
}

function scorePartition(records: RecipeBenchmarkRecord[]) {
  const totals = {
    candidate: { evaluated: 0, correct: 0 }, compatibility: { evaluated: 0, correct: 0 },
    allowedSurvival: { evaluated: 0, correct: 0 },
    incompatibleExclusion: { evaluated: 0, correct: 0 },
    unknownSurvival: { evaluated: 0, correct: 0 },
    resolution: { evaluated: 0, correct: 0 }, quantity: { evaluated: 0, correct: 0 },
    provenance: { evaluated: 0, correct: 0 },
  };
  let exact = 0;
  let exactEvaluated = 0;
  let ambiguous = 0;
  const unscoredAlignmentAmbiguity: Array<{ product_id: number; reason: string }> = [];
  const unscoredFinalRecipe: Array<{ product_id: number; reason: string }> = [];
  let corrections = 0;
  const perProduct: Array<Record<string, unknown>> = [];
  const extractionPerProduct: ReturnType<typeof semanticExtractionForRecord>[] = [];
  const baseItemResolutionPerProduct: ReturnType<typeof baseItemResolutionForRecord>[] = [];
  const lineagePerProduct: Array<FinalLineLineageAudit & { product_id: number }> = [];
  for (const record of records) {
    const generationUnavailable =
      record.generationStatus === "failed" || record.generationStatus === "unsupported";
    const alignment = generationUnavailable ? null : bestAlignment(record.suggestion, record.annotation);
    const lineage = auditFinalLineLineage(record);
    lineagePerProduct.push({ product_id: record.product.id, ...lineage });
    baseItemResolutionPerProduct.push(baseItemResolutionForRecord(record, alignment));
    extractionPerProduct.push(semanticExtractionForRecord(record, alignment));
    if (generationUnavailable) {
      const exactness = annotationHasDefinitiveExactness(record.annotation) ? false : null;
      if (exactness === false) exactEvaluated++;
      else {
        unscoredFinalRecipe.push({
          product_id: record.product.id,
          reason: "failed_or_unsupported_generation_has_no_definitive_complete_final_recipe_gold",
        });
      }
      const expected = failedGenerationSemanticConsensus(record.annotation).requirements;
      corrections += expected.length;
      perProduct.push({
        product_id: record.product.id,
        generation_status: record.generationStatus,
        selected_variant_id: null,
        alignment_ambiguous: false,
        full_recipe_exact: exactness,
        final_line_lineage_safety: lineage,
      });
      continue;
    }
    if (alignment) {
      metricAdd(totals.candidate, alignment.candidate_retrieval);
      metricAdd(totals.compatibility, alignment.compatibility);
      metricAdd(totals.allowedSurvival, alignment.compatibility_breakdown.allowed_survival);
      metricAdd(totals.incompatibleExclusion, alignment.compatibility_breakdown.known_incompatible_exclusion);
      metricAdd(totals.unknownSurvival, alignment.compatibility_breakdown.expected_unknown_survival);
      metricAdd(totals.resolution, alignment.resolution);
      metricAdd(totals.quantity, alignment.quantity);
      metricAdd(totals.provenance, alignment.provenance_integrity);
      const exactness = semanticExactness(record, alignment);
      const isExact = exactness === true;
      if (exactness != null) {
        exactEvaluated++;
        if (isExact) exact++;
      } else if (alignment.ambiguous) {
        unscoredAlignmentAmbiguity.push({
          product_id: record.product.id,
          reason: "semantic_alignment_remained_ambiguous_after_all_scoring_relevant_evidence",
        });
      } else {
        unscoredFinalRecipe.push({
          product_id: record.product.id,
          reason: record.annotation?.finalRecipe?.disposition === "partial_catalog_coverage"
            ? "partial_catalog_coverage_has_no_complete_acceptable_final_variant"
            : "base_item_or_hidden_rule_expectation_is_not_definitive",
        });
      }
      if (alignment.ambiguous || hasAmbiguousResult(record.suggestion)) ambiguous++;
      corrections += alignment.unmatched_expected.length + alignment.unmatched_actual.length
        + (alignment.resolution.evaluated - alignment.resolution.correct)
        + (alignment.quantity.evaluated - alignment.quantity.correct);
      perProduct.push({
        product_id: record.product.id,
        selected_variant_id: alignment.variant_id,
        alignment_ambiguous: alignment.ambiguous,
        full_recipe_exact: exactness,
        candidate_retrieval: alignment.candidate_retrieval,
        compatibility: alignment.compatibility,
        compatibility_breakdown: alignment.compatibility_breakdown,
        resolution: alignment.resolution,
        quantity: alignment.quantity,
        provenance_integrity: alignment.provenance_integrity,
        final_line_lineage_safety: lineage,
        unmatched_expected: alignment.unmatched_expected,
        unmatched_actual: alignment.unmatched_actual,
      });
    } else {
      const isExact = fullRecipeExact(record.comparison);
      exactEvaluated++;
      if (isExact) exact++;
      if (hasAmbiguousResult(record.suggestion)) ambiguous++;
      corrections += record.comparison.missingItems.length + record.comparison.incorrectExtras.length
        + record.comparison.quantity.comparedCount - record.comparison.quantity.correctCount;
      perProduct.push({
        product_id: record.product.id,
        selected_variant_id: null,
        alignment_ambiguous: false,
        full_recipe_exact: isExact,
        legacy_recipe_fallback: true,
        final_line_lineage_safety: lineage,
      });
    }
  }
  const extractionTotals = extractionPerProduct.reduce((totals, item) => ({
    expected: totals.expected + item.definitive_expected_gold_requirements,
    aligned: totals.aligned + item.unambiguously_aligned_extracted_requirements,
    missing: totals.missing + item.missing_gold_requirements.length,
    unmatched: totals.unmatched + item.unmatched_extracted_requirements.length,
    duplicates: totals.duplicates + item.duplicate_extraction.length,
    ambiguous: totals.ambiguous + item.ambiguous_alignment.length,
    precisionEvaluated: totals.precisionEvaluated + item.precision.evaluated,
    precisionCorrect: totals.precisionCorrect + item.precision.correct,
    recallEvaluated: totals.recallEvaluated + item.recall.evaluated,
    recallCorrect: totals.recallCorrect + item.recall.correct,
  }), {
    expected: 0, aligned: 0, missing: 0, unmatched: 0, duplicates: 0, ambiguous: 0,
    precisionEvaluated: 0, precisionCorrect: 0, recallEvaluated: 0, recallCorrect: 0,
  });
  const failureStages = extractionPerProduct.flatMap(({ failure_stages }) => failure_stages);
  const failureStageNames: RequirementFailureStage[] = [
    "extraction_failure", "candidate_retrieval_failure", "compatibility_exclusion_failure",
    "unknown_evidence_withholding", "genuine_compatible_ambiguity", "contextual_resolution_failure",
    "base_item_resolution_failure", "quantity_failure", "provenance_failure",
  ];
  const formatAndContext = scoreFormatAndContext(records);
  const scoredBaseItemResolution = baseItemResolutionPerProduct.filter((item) => item.scored);
  const baseItemResolutionTotals = scoredBaseItemResolution.reduce((totals, item) => ({
    positive: totals.positive + item.definitive_positive_gold_requirements,
    resolved: totals.resolved + item.resolved_semantic_predictions,
    correct: totals.correct + item.correctly_resolved_allowed_base_item_matches,
    incorrect: totals.incorrect + item.incorrectly_resolved_semantic_lines,
    falsePositive: totals.falsePositive + item.false_positive_resolved_semantic_lines,
    missed: totals.missed + item.missed_or_unresolved_positive_requirements,
    ambiguous: totals.ambiguous + item.ambiguous_outcomes,
    noMatch: totals.noMatch + item.no_match_outcomes,
    expectedAmbiguous: totals.expectedAmbiguous + item.expected_ambiguous_outcomes_excluded,
    expectedNoMatch: totals.expectedNoMatch + item.expected_no_match_outcomes_excluded,
    undefinedGold: totals.undefinedGold + item.undefined_base_item_gold_requirements_unscored,
  }), {
    positive: 0, resolved: 0, correct: 0, incorrect: 0, falsePositive: 0,
    missed: 0, ambiguous: 0, noMatch: 0, expectedAmbiguous: 0, expectedNoMatch: 0,
    undefinedGold: 0,
  });
  const baseItemResolutionExclusions = baseItemResolutionPerProduct.reduce((totals, item) => ({
    expectedAmbiguous: totals.expectedAmbiguous + item.expected_ambiguous_outcomes_excluded,
    expectedNoMatch: totals.expectedNoMatch + item.expected_no_match_outcomes_excluded,
    undefinedGold: totals.undefinedGold + item.undefined_base_item_gold_requirements_unscored,
  }), { expectedAmbiguous: 0, expectedNoMatch: 0, undefinedGold: 0 });
  const basePrecision = baseItemResolutionTotals.resolved === 0
    ? null
    : round(baseItemResolutionTotals.correct / baseItemResolutionTotals.resolved);
  const baseRecall = baseItemResolutionTotals.positive === 0
    ? null
    : round(baseItemResolutionTotals.correct / baseItemResolutionTotals.positive);
  const baseF1 = baseRecall == null
    ? null
    : basePrecision == null ? 0
      : basePrecision + baseRecall === 0
        ? 0
        : round((2 * basePrecision * baseRecall) / (basePrecision + baseRecall));
  const flattenLineage = (key: keyof FinalLineLineageAudit) =>
    lineagePerProduct.flatMap((item) => item[key]);
  const lineageMetric = (key: keyof FinalLineLineageAudit) => {
    const affected = flattenLineage(key);
    return {
      count: affected.length,
      affected_product_ids: [...new Set(affected.map((item) => item.product_id))].sort((a, b) => a - b),
      affected_lines: affected,
    };
  };
  return {
    product_count: records.length,
    candidate_retrieval: countMetric(totals.candidate.evaluated, totals.candidate.correct),
    compatibility: countMetric(totals.compatibility.evaluated, totals.compatibility.correct),
    compatibility_breakdown: {
      allowed_survival: countMetric(totals.allowedSurvival.evaluated, totals.allowedSurvival.correct),
      known_incompatible_exclusion: countMetric(
        totals.incompatibleExclusion.evaluated,
        totals.incompatibleExclusion.correct,
      ),
      expected_unknown_survival: countMetric(totals.unknownSurvival.evaluated, totals.unknownSurvival.correct),
    },
    resolution_accuracy: countMetric(totals.resolution.evaluated, totals.resolution.correct),
    base_item_resolution: {
      scored_products: scoredBaseItemResolution.length,
      unscored_products: baseItemResolutionPerProduct.length - scoredBaseItemResolution.length,
      definitive_positive_gold_requirements: baseItemResolutionTotals.positive,
      resolved_semantic_predictions: baseItemResolutionTotals.resolved,
      correctly_resolved_allowed_base_item_matches: baseItemResolutionTotals.correct,
      incorrectly_resolved_semantic_lines: baseItemResolutionTotals.incorrect,
      false_positive_resolved_semantic_lines: baseItemResolutionTotals.falsePositive,
      missed_or_unresolved_positive_requirements: baseItemResolutionTotals.missed,
      ambiguous_outcomes: baseItemResolutionTotals.ambiguous,
      no_match_outcomes: baseItemResolutionTotals.noMatch,
      expected_ambiguous_outcomes_excluded: baseItemResolutionExclusions.expectedAmbiguous,
      expected_no_match_outcomes_excluded: baseItemResolutionExclusions.expectedNoMatch,
      undefined_base_item_gold_requirements_unscored: baseItemResolutionExclusions.undefinedGold,
      precision: basePrecision,
      recall: baseRecall,
      f1: baseF1,
      per_product: baseItemResolutionPerProduct,
    },
    quantity_accuracy: countMetric(totals.quantity.evaluated, totals.quantity.correct),
    provenance_integrity: countMetric(totals.provenance.evaluated, totals.provenance.correct),
    final_line_lineage_safety: {
      unsupported_final_lines: lineageMetric("unsupported_final_lines"),
      dangling_requirement_lines: lineageMetric("dangling_requirement_lines"),
      missing_or_invalid_requirement_provenance:
        lineageMetric("missing_or_invalid_requirement_provenance"),
      per_product: lineagePerProduct,
    },
    full_recipe_exact_match: countMetric(exactEvaluated, exact),
    unscored_alignment_ambiguity: {
      count: unscoredAlignmentAmbiguity.length,
      products: unscoredAlignmentAmbiguity,
    },
    unscored_final_recipe: {
      count: unscoredFinalRecipe.length,
      products: unscoredFinalRecipe,
    },
    ambiguous_match: { products: ambiguous, denominator: records.length, rate: records.length ? round(ambiguous / records.length) : null },
    per_product: perProduct,
    semantic_requirement_extraction: {
      definitive_expected_gold_requirements: extractionTotals.expected,
      unambiguously_aligned_extracted_requirements: extractionTotals.aligned,
      missing_gold_requirements: extractionTotals.missing,
      unmatched_extracted_requirements: extractionTotals.unmatched,
      false_positive_extracted_requirements: extractionTotals.unmatched,
      duplicate_extraction: extractionTotals.duplicates,
      ambiguous_alignment: extractionTotals.ambiguous,
      extraction_precision: countMetric(extractionTotals.precisionEvaluated, extractionTotals.precisionCorrect),
      extraction_recall: countMetric(extractionTotals.recallEvaluated, extractionTotals.recallCorrect),
      per_product: extractionPerProduct,
    },
    failure_stage_taxonomy: {
      counts: Object.fromEntries(failureStageNames.map((stage) =>
        [stage, failureStages.filter((failure) => failure.stage === stage).length])),
      affected_requirements: Object.fromEntries(failureStageNames.map((stage) =>
        [stage, failureStages.filter((failure) => failure.stage === stage)])),
    },
    hidden_rule_accuracy: scoreHiddenRules(records),
    format_and_context_accuracy: formatAndContext,
    estimated_review_burden: {
      products_requiring_review: records.length - exact,
      product_denominator: records.length,
      review_rate: records.length ? round((records.length - exact) / records.length) : null,
      estimated_edits: corrections,
      average_edits_per_product: records.length ? round(corrections / records.length) : null,
    },
  };
}

function formatGroups(records: RecipeBenchmarkRecord[]) {
  const groups = new Map<string, RecipeBenchmarkRecord[]>();
  for (const record of records) {
    const format = record.annotation?.expected?.canonicalProductFormat ?? "Unspecified canonical format";
    const category = record.product.category?.trim() || "Uncategorized";
    const key = `${format} / ${category}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()].map(([key, products]) => {
    const split = key.lastIndexOf(" / ");
    const alignments = products.map((record) =>
      record.generationStatus === "failed" || record.generationStatus === "unsupported"
        ? null
        : bestAlignment(record.suggestion, record.annotation));
    const exactness = products.map((record, index) => {
      const alignment = alignments[index];
      if (record.generationStatus === "failed" || record.generationStatus === "unsupported") {
        return annotationHasDefinitiveExactness(record.annotation) ? false : null;
      }
      return alignment ? semanticExactness(record, alignment) : null;
    });
    const scoredAlignments = alignments.filter((alignment): alignment is SemanticAlignment =>
      alignment != null && !alignment.ambiguous);
    const baseItemRecords = products.map((record, index) =>
      baseItemResolutionForRecord(record, alignments[index]));
    const scoredBaseItemRecords = baseItemRecords.filter((item) => item.scored);
    const positive = scoredBaseItemRecords.reduce(
      (sum, item) => sum + item.definitive_positive_gold_requirements,
      0,
    );
    const resolved = scoredBaseItemRecords.reduce(
      (sum, item) => sum + item.resolved_semantic_predictions,
      0,
    );
    const correct = scoredBaseItemRecords.reduce(
      (sum, item) => sum + item.correctly_resolved_allowed_base_item_matches,
      0,
    );
    const precision = resolved === 0 ? null : round(correct / resolved);
    const recall = positive === 0 ? null : round(correct / positive);
    const f1 = recall == null
      ? null
      : precision == null ? 0
        : precision + recall === 0 ? 0 : round((2 * precision * recall) / (precision + recall));
    return {
      format: key.slice(0, split), category: key.slice(split + 3), product_count: products.length,
      scored_product_count: scoredBaseItemRecords.length,
      unscored_alignment_ambiguity: alignments.filter((alignment) => alignment?.ambiguous).length,
      base_item_precision: precision,
      base_item_recall: recall,
      base_item_f1: f1,
      quantity_accuracy: countMetric(
        scoredAlignments.reduce((n, alignment) => n + alignment.quantity.evaluated, 0),
        scoredAlignments.reduce((n, alignment) => n + alignment.quantity.correct, 0),
      ),
      full_recipe_exact_match: countMetric(
        exactness.filter((result) => result != null).length,
        exactness.filter((result) => result === true).length,
      ),
    };
  }).sort((a, b) => a.format.localeCompare(b.format) || a.category.localeCompare(b.category));
}

function benchmarkLeakageSafety(records: RecipeBenchmarkRecord[]) {
  const perProduct = records.map((record) => {
    const reasons: string[] = [];
    const safety = record.generationSafety;
    if (!safety) {
      reasons.push("generation_input_audit_missing");
    } else {
      if (safety.targetRecipeInputPresent) reasons.push("target_recipe_present_in_generation_input");
      if (safety.targetCorrectionHistoryInputPresent) {
        reasons.push("target_correction_history_present_in_generation_input");
      }
      if (safety.supportingProductIds.includes(record.product.id)) {
        reasons.push("target_product_present_in_supporting_products");
      }
    }
    if (
      record.suggestion.targetProductId !== record.product.id
      || record.suggestion.leaveOneOut.excludedProductId !== record.product.id
      || record.suggestion.leaveOneOut.directRecipeWithheld !== true
    ) {
      reasons.push("matcher_leave_one_out_target_mismatch");
    }
    if (record.suggestion.leaveOneOut.supportingProductIds.includes(record.product.id)) {
      reasons.push("target_product_present_in_matcher_supporting_products");
    }
    return {
      product_id: record.product.id,
      target_recipe_withheld: safety != null
        && !safety.targetRecipeInputPresent
        && record.suggestion.leaveOneOut.directRecipeWithheld === true,
      target_correction_history_withheld: safety != null
        && !safety.targetCorrectionHistoryInputPresent,
      target_product_absent_from_supporting_products: safety != null
        && !safety.supportingProductIds.includes(record.product.id)
        && !record.suggestion.leaveOneOut.supportingProductIds.includes(record.product.id),
      violation_count: reasons.length,
      reasons,
    };
  });
  const reasons = perProduct.flatMap((item) =>
    item.reasons.map((reason) => ({ product_id: item.product_id, reason })));
  return {
    target_recipe_withheld: perProduct.every((item) => item.target_recipe_withheld),
    target_correction_history_withheld:
      perProduct.every((item) => item.target_correction_history_withheld),
    target_product_absent_from_supporting_products:
      perProduct.every((item) => item.target_product_absent_from_supporting_products),
    target_leakage_violation_count: reasons.length,
    target_leakage_violation_reasons: reasons,
    per_product: perProduct,
  };
}

export function buildRecipeBenchmarkMetrics(records: RecipeBenchmarkRecord[]): Record<string, unknown> {
  const scored = records.filter(({ generationStatus }) => generationStatus !== "failed" && generationStatus !== "unsupported");
  const unscored = records.filter(({ generationStatus }) => generationStatus === "failed" || generationStatus === "unsupported");
  const isProvisional = ({ annotation }: RecipeBenchmarkRecord) =>
    annotation?.status === "provisional" || annotation?.status === "draft";
  const isCanonical = ({ annotation }: RecipeBenchmarkRecord) => annotation?.status === "canonical";
  const canonicalPopulation = records.filter(isCanonical);
  const provisionalPopulation = records.filter(isProvisional);
  const canonical = scored.filter(isCanonical);
  const provisional = scored.filter(isProvisional);
  const canonicalScore = scorePartition(canonicalPopulation);
  const provisionalScore = scorePartition(provisionalPopulation);
  const legacyScore = scorePartition(scored);
  const canonicalAccepted = canonicalScore.full_recipe_exact_match.correct;
  canonicalScore.estimated_review_burden = {
    ...canonicalScore.estimated_review_burden,
    products_requiring_review: canonicalPopulation.length - canonicalAccepted,
    product_denominator: canonicalPopulation.length,
    review_rate: canonicalPopulation.length
      ? round((canonicalPopulation.length - canonicalAccepted) / canonicalPopulation.length) : null,
  };
  const fields: Record<string, { evaluated: number; correct: number }> = {};
  for (const record of canonical) {
    if (!record.annotation) continue;
    const result = compareStructuredAnnotation(record.suggestion.structure, record.annotation);
    for (const [name, metric] of Object.entries(result.fields)) metricAdd(fields[name] ??= { evaluated: 0, correct: 0 }, metric);
  }
  const canonicalFormatGroups = formatGroups(canonicalPopulation);
  const fingerprintInput = (items: RecipeBenchmarkRecord[]) => [...items]
    .sort((a, b) => a.product.id - b.product.id)
    .map(({ product, annotation }) => ({
      product_id: product.id,
      scoring: annotation ? recipeBenchmarkAnnotationScoringProjection(annotation) : null,
    }));
  const canonicalFingerprint = deterministicRecipeFingerprint(fingerprintInput(canonicalPopulation));
  const provisionalFingerprint = deterministicRecipeFingerprint(fingerprintInput(provisionalPopulation));
  const expectedLines = canonical.reduce((sum, record) => sum + record.comparison.baseItem.expectedCount, 0);
  const matchedLines = canonical.reduce((sum, record) => sum + record.comparison.baseItem.matchedCount, 0);
  const exactAcrossAllReceived = records.filter((record) =>
    record.generationStatus !== "failed" && record.generationStatus !== "unsupported"
    && fullRecipeExact(record.comparison)).length;
  return {
    annotation_fingerprints: {
      canonical: canonicalFingerprint,
      provisional: provisionalFingerprint,
      combined: deterministicRecipeFingerprint({ canonical: canonicalFingerprint, provisional: provisionalFingerprint }),
    },
    denominators: {
      received_products: records.length, scored_products: scored.length, unscored_products: unscored.length,
      canonical_products: canonicalPopulation.length, provisional_products: provisionalPopulation.length,
      scored_canonical_products: canonical.length, scored_provisional_products: provisional.length,
      unscored_product_ids: records
        .filter((record) => !isCanonical(record) && !isProvisional(record) || unscored.includes(record))
        .map(({ product }) => product.id),
    },
    canonical_metrics: canonicalScore,
    provisional_metrics: provisionalScore,
    canonical: canonicalScore,
    provisional: provisionalScore,
    legacy_metrics: legacyScore,
    candidate_retrieval: legacyScore.candidate_retrieval,
    compatibility: legacyScore.compatibility,
    resolution_accuracy: legacyScore.resolution_accuracy,
    quantity_accuracy: legacyScore.quantity_accuracy,
    provenance_integrity: legacyScore.provenance_integrity,
    full_recipe_exact_match: legacyScore.full_recipe_exact_match,
    ambiguous_match: legacyScore.ambiguous_match,
    estimated_review_burden: legacyScore.estimated_review_burden,
    estimated_manual_review_burden: {
      description: "Estimated benchmark-versus-gold review burden; not observed human editing behavior.",
      canonical: canonicalScore.estimated_review_burden,
      provisional: provisionalScore.estimated_review_burden,
    },
    semantic_requirement_extraction: {
      canonical: canonicalScore.semantic_requirement_extraction,
      provisional: provisionalScore.semantic_requirement_extraction,
    },
    base_item_resolution: {
      canonical: canonicalScore.base_item_resolution,
      provisional: provisionalScore.base_item_resolution,
    },
    final_line_lineage_safety: {
      canonical: canonicalScore.final_line_lineage_safety,
      provisional: provisionalScore.final_line_lineage_safety,
    },
    benchmark_leakage_safety: benchmarkLeakageSafety(records),
    failure_stage_taxonomy: {
      canonical: canonicalScore.failure_stage_taxonomy,
      provisional: provisionalScore.failure_stage_taxonomy,
    },
    correct_base_item_selection: {
      expected_lines: scored.reduce((sum, record) => sum + record.comparison.baseItem.expectedCount, 0),
      correctly_selected_lines: scored.reduce((sum, record) => sum + record.comparison.baseItem.matchedCount, 0),
      accuracy: scored.reduce((sum, record) => sum + record.comparison.baseItem.expectedCount, 0)
        ? round(
            scored.reduce((sum, record) => sum + record.comparison.baseItem.matchedCount, 0)
            / scored.reduce((sum, record) => sum + record.comparison.baseItem.expectedCount, 0),
          )
        : null,
    },
    manual_review_burden: {
      products: records.length,
      reviewed_products: records.length - exactAcrossAllReceived,
      manual_review_rate: records.length ? round((records.length - exactAcrossAllReceived) / records.length) : null,
      accepted_without_edits: exactAcrossAllReceived,
      average_corrections_per_product: records.length
        ? (canonicalScore.estimated_review_burden.average_edits_per_product ?? 0) : null,
    },
    confidence_calibration: (() => {
      const bands: Record<string, { evaluated: number; correct: number; accuracy: number | null }> = {};
      for (const record of records) {
        const band = hasAmbiguousResult(record.suggestion) ? "ambiguous"
          : record.suggestion.lines.length === 0 ? "no_match"
            : record.suggestion.lines.some((line) => line.confidence === "low") ? "low"
              : record.suggestion.lines.some((line) => line.confidence === "medium") ? "medium" : "high";
        const target = bands[band] ??= countMetric(0, 0);
        target.evaluated++;
        if (record.generationStatus !== "failed" && record.generationStatus !== "unsupported"
          && fullRecipeExact(record.comparison)) target.correct++;
        target.accuracy = round(target.correct / target.evaluated);
      }
      return { bands };
    })(),
    extraction_accuracy: {
      fields: Object.fromEntries(Object.entries(fields).map(([key, x]) => [key, countMetric(x.evaluated, x.correct)])),
      limitation: "Only explicitly reviewed canonical fields are scored.",
    },
    format_accuracy: (() => {
      const metric = fields.canonicalProductFormat ?? { evaluated: 0, correct: 0 };
      return countMetric(metric.evaluated, metric.correct);
    })(),
    stem_length_accuracy: (() => {
      const metric = fields.stemLengthCm ?? { evaluated: 0, correct: 0 };
      return countMetric(metric.evaluated, metric.correct);
    })(),
    dimension_accuracy: (() => {
      const metric = fields.dimensionsCm ?? { evaluated: 0, correct: 0 };
      return countMetric(metric.evaluated, metric.correct);
    })(),
    context_rule_accuracy: canonicalScore.format_and_context_accuracy.contextual_resolver,
    hidden_rule_accuracy: canonicalScore.hidden_rule_accuracy,
    canonical_format_groups: canonicalFormatGroups,
    regression_gate_inputs: { canonical_only: true, annotation_fingerprint: canonicalFingerprint, canonical_format_groups: canonicalFormatGroups },
    successfully_generated_product_ids: scored.map(({ product }) => product.id),
    failed_or_unsupported_product_ids: unscored.map(({ product }) => product.id),
    failed_or_unsupported_generation_metric_policy:
      "Included only in metrics for which definitive gold exists; otherwise explicitly unscored.",
  };
}

export type RegressionGateResult = {
  status: "pass" | "flagged" | "no_baseline" | "incomparable";
  baseline_run_id: number | null;
  flagged_formats: Array<{ format: string; category: string; baseline: Record<string, unknown>; current: Record<string, unknown>; reasons: string[] }>;
  decision_support_only: true;
};

export function buildRecipeRegressionGate(
  currentMetrics: Record<string, unknown>,
  baselineMetrics: Record<string, unknown> | null,
  baselineRunId: number | null = null,
): RegressionGateResult {
  if (!baselineMetrics) return { status: "no_baseline", baseline_run_id: baselineRunId, flagged_formats: [], decision_support_only: true };
  const groups = (metrics: Record<string, unknown>) => {
    const gate = metrics.regression_gate_inputs as Record<string, unknown> | undefined;
    const value = gate?.canonical_format_groups ?? metrics.canonical_format_groups;
    return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
  };
  const current = groups(currentMetrics);
  const baseline = groups(baselineMetrics);
  const baselineByKey = new Map(baseline.map((x) => [`${x.format} / ${x.category}`, x]));
  const currentByKey = new Map(current.map((x) => [`${x.format} / ${x.category}`, x]));
  const flagged: RegressionGateResult["flagged_formats"] = [];
  for (const item of current) {
    if (item.scored_product_count === 0) continue;
    const old = baselineByKey.get(`${item.format} / ${item.category}`);
    if (!old) {
      flagged.push({ format: String(item.format), category: String(item.category), baseline: {}, current: item, reasons: ["missing_baseline_group"] });
      continue;
    }
    const reasons: string[] = [];
    const worse = (currentValue: unknown, baselineValue: unknown) =>
      typeof currentValue === "number"
      && typeof baselineValue === "number"
      && currentValue < baselineValue;
    if (worse(item.base_item_f1, old.base_item_f1)) reasons.push("base_item_f1_worse");
    if (worse(
      (item.full_recipe_exact_match as Record<string, unknown>)?.accuracy,
      (old.full_recipe_exact_match as Record<string, unknown>)?.accuracy,
    )) reasons.push("full_recipe_exact_match_worse");
    if (worse(
      (item.quantity_accuracy as Record<string, unknown>)?.accuracy,
      (old.quantity_accuracy as Record<string, unknown>)?.accuracy,
    )) reasons.push("quantity_accuracy_worse");
    if (reasons.length) flagged.push({ format: String(item.format), category: String(item.category), baseline: old, current: item, reasons });
  }
  for (const old of baseline) if (!currentByKey.has(`${old.format} / ${old.category}`)) {
    flagged.push({ format: String(old.format), category: String(old.category), baseline: old, current: {}, reasons: ["missing_current_group"] });
  }
  const incomparable = flagged.some(({ reasons }) => reasons.some((x) => x.startsWith("missing_")));
  return {
    status: incomparable ? "incomparable" : flagged.length ? "flagged" : "pass",
    baseline_run_id: baselineRunId, flagged_formats: flagged, decision_support_only: true,
  };
}

export const RECIPE_BENCHMARK_REGRESSION_CORPUS = [
  "flower-box-red-rose-40cm", "wooden-letter-red-rose-40cm", "wooden-heart-red-rose-40cm",
  "hand-bouquet-red-rose-60cm", "no-generic-50cm-default", "equivalent-dimension-notation",
  "governed-package-count", "ambiguous-variant", "approved-alias", "similar-recipe-support",
  "image-conflict-is-supporting-only", "hidden-sponge-and-metal-ring", "rejected-no-match",
  "helium-semantic", "sponge-metal-ring-independent",
] as const;