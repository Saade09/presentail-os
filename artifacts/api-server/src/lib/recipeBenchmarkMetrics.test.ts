import { describe, expect, it } from "vitest";
import {
  alignRecipeSemantics,
  buildRecipeBenchmarkMetrics,
  buildRecipeRegressionGate,
  compareStructuredAnnotation,
  recipeBenchmarkAnnotationScoringProjection,
  RECIPE_BENCHMARK_REGRESSION_CORPUS,
  type RecipeBenchmarkRecord,
  type SemanticRecipeLine,
} from "./recipeBenchmarkMetrics";
import {
  compareRecipeSuggestion,
  extractProductStructure,
  generateRecipeSuggestion,
  type RecipeLineInput,
  type RecipeSuggestion,
  type SuggestionProduct,
} from "./recipeSuggestionEngine";

const redRose: RecipeLineInput = {
  baseItemId: 1,
  baseItemName: "Red Rose 40cm",
  quantity: 1,
};

function product(overrides: Partial<SuggestionProduct> = {}): SuggestionProduct {
  return {
    id: 900,
    name: "20 Red Roses Flower Box 40 cm x 17 cm x 20 cm",
    description: null,
    descriptionAr: null,
    category: "Flowers",
    tags: [],
    recipes: [{ ...redRose, quantity: 20 }],
    ...overrides,
  };
}

function benchmarkRecord(target: SuggestionProduct): RecipeBenchmarkRecord {
  const { recipes, ...generationTarget } = target;
  const suggestion = generateRecipeSuggestion(generationTarget, [], [redRose]);
  return {
    product: target,
    suggestion,
    comparison: compareRecipeSuggestion(suggestion, recipes, target),
    annotation: {
      productId: target.id,
      status: "canonical",
      expected: {
        ingredientFamily: "rose",
        color: "red",
        canonicalProductFormat: "Flower Box" as const,
        dimensionsCm: [40, 17, 20],
      },
      note: "Manually annotated fixture",
    },
    generationSafety: {
      targetRecipeInputPresent: false,
      targetCorrectionHistoryInputPresent: false,
      supportingProductIds: [],
    },
  };
}

const evidence = (occurrence: number) => ({
  sourceField: "description" as const,
  sourceIndex: 0,
  lineIndex: 0,
  componentIndex: occurrence,
  occurrence,
  exactPhrase: "helium balloon",
  normalizedPhrase: "helium balloon",
  span: { start: occurrence * 20, end: occurrence * 20 + 14 },
});

function semanticSuggestion(requirements: Array<{
  requirementId: string;
  semanticKey: string;
  candidates: number[];
  selected: number;
  quantity?: number;
}>): RecipeSuggestion {
  const seed = benchmarkRecord(product()).suggestion;
  return {
    ...seed,
    requirements: requirements.map((item, index) => ({
      requirementId: item.requirementId,
      kind: "component" as const,
      subtype: null,
      category: null,
      phrase: item.semanticKey,
      quantity: item.quantity ?? 1,
      unit: null,
      attributes: { semanticKey: item.semanticKey },
      preCompatibilityCandidateBaseItemIds: item.candidates,
      candidateBaseItemIds: item.candidates,
      resolution: "matched" as const,
      evidence: evidence(index),
      similarEvidence: [],
    })),
    lines: requirements.map((item, index) => ({
      baseItemId: item.selected,
      baseItemName: item.semanticKey,
      quantity: item.quantity ?? 1,
      confidence: "high" as const,
      source: "deterministic_rule" as const,
      reason: "fixture",
      hiddenRuleKey: null,
      unresolved: false,
      requirementId: item.requirementId,
      requirementProvenance: {
        requirementId: item.requirementId,
        kind: "component" as const,
        phrase: item.semanticKey,
        quantity: item.quantity ?? 1,
        unit: null,
        attributes: { semanticKey: item.semanticKey },
        candidateBaseItemIds: item.candidates,
        resolution: "matched" as const,
        evidence: evidence(index),
        similarEvidence: [],
      },
    })),
    conflicts: [],
    unresolvedRequirements: [],
  };
}

function exactSemanticRecord(id: number): RecipeBenchmarkRecord {
  const record = benchmarkRecord(product({ id }));
  record.suggestion = semanticSuggestion([
    { requirementId: "actual-rose", semanticKey: "rose", candidates: [1], selected: 1, quantity: 20 },
  ]);
  record.suggestion.targetProductId = id;
  record.suggestion.leaveOneOut.excludedProductId = id;
  record.annotation = {
    productId: id,
    status: "canonical",
    finalRecipe: {
      disposition: "complete",
      acceptableVariants: [{
        id: "complete",
        lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1], quantity: 20 }],
        hiddenRules: [],
      }],
    },
  };
  return record;
}

describe("Recipe benchmark metrics", () => {
  it("scores only explicitly annotated structured fields and normalizes equivalent dimensions", () => {
    const comparison = compareStructuredAnnotation(
      extractProductStructure({
        name: "Red Rose Flower Box",
        description: "40 cm × 170 mm × 7.874 in",
      }),
      {
        productId: 1,
        expected: {
          ingredientFamily: "rose",
          color: "red",
          canonicalProductFormat: "Flower Box",
          dimensionsCm: [40, 17, 20],
        },
        note: "fixture",
      },
    );

    expect(comparison).toMatchObject({
      evaluated: 4,
      correct: 4,
      accuracy: 1,
      fields: {
        dimensionsCm: { evaluated: 1, correct: 1, accuracy: 1 },
      },
    });
  });

  it("reports exact Recipe accuracy, calibration, review burden, and denominators", () => {
    const metrics = buildRecipeBenchmarkMetrics([benchmarkRecord(product())]);

    expect(metrics).toMatchObject({
      correct_base_item_selection: {
        expected_lines: 1,
        correctly_selected_lines: 1,
        accuracy: 1,
      },
      full_recipe_exact_match: { evaluated: 1, correct: 1, accuracy: 1 },
      confidence_calibration: {
        bands: {
          high: { evaluated: 1, correct: 1, accuracy: 1 },
        },
      },
      manual_review_burden: {
        products: 1,
        manual_review_rate: 0,
        accepted_without_edits: 1,
        average_corrections_per_product: 0,
      },
      successfully_generated_product_ids: [900],
      failed_or_unsupported_product_ids: [],
      failed_or_unsupported_generation_metric_policy:
        "Included only in metrics for which definitive gold exists; otherwise explicitly unscored.",
    });
  });

  it("flags a per-format regression without changing any learning state", () => {
    const current = {
      canonical_format_groups: [{
        format: "Flower Box",
        category: "Flowers",
        base_item_f1: 0.5,
        quantity_accuracy: { accuracy: 0.5 },
        full_recipe_exact_match: { accuracy: 0 },
      }],
    };
    const baseline = {
      canonical_format_groups: [{
        format: "Flower Box",
        category: "Flowers",
        base_item_f1: 1,
        quantity_accuracy: { accuracy: 1 },
        full_recipe_exact_match: { accuracy: 1 },
      }],
    };

    expect(buildRecipeRegressionGate(current, baseline, 42)).toEqual({
      status: "flagged",
      baseline_run_id: 42,
      decision_support_only: true,
      flagged_formats: [
        expect.objectContaining({
          format: "Flower Box",
          reasons: [
            "base_item_f1_worse",
            "full_recipe_exact_match_worse",
            "quantity_accuracy_worse",
          ],
        }),
      ],
    });
    expect(RECIPE_BENCHMARK_REGRESSION_CORPUS).toEqual(expect.arrayContaining([
      "flower-box-red-rose-40cm",
      "no-generic-50cm-default",
      "equivalent-dimension-notation",
      "approved-alias",
      "image-conflict-is-supporting-only",
      "hidden-sponge-and-metal-ring",
      "rejected-no-match",
    ]));
  });

  it("keeps repeated indistinguishable requirements ambiguous and does not use IDs as semantics", () => {
    const suggestion = semanticSuggestion([
      { requirementId: "actual-z", semanticKey: "rose", candidates: [1], selected: 1 },
      { requirementId: "actual-a", semanticKey: "rose", candidates: [1], selected: 1 },
    ]);
    const alignment = alignRecipeSemantics(suggestion, {
      id: "variant",
      lines: [
        { id: "gold-a", semanticKey: "rose", acceptableBaseItemIds: [1], quantity: 1 },
        { id: "gold-z", semanticKey: "rose", acceptableBaseItemIds: [1], quantity: 1 },
      ],
    });

    expect(alignment).toMatchObject({
      ambiguous: true,
      optimal_alignment_count: 2,
      resolution: { evaluated: 0, correct: 0, accuracy: null },
      provenance_integrity: { evaluated: 0, correct: 0, accuracy: null },
    });
  });

  it("scores Helium by semantic compatibility while reporting retrieval separately", () => {
    const suggestion = semanticSuggestion([
      { requirementId: "not-the-gold-id", semanticKey: "helium", candidates: [70, 71], selected: 71 },
    ]);
    const alignment = alignRecipeSemantics(suggestion, {
      lines: [{ id: "helium-gold", semanticKey: "helium", acceptableBaseItemIds: [70], quantity: 1 }],
    });

    expect(alignment.candidate_retrieval).toEqual({ evaluated: 1, correct: 1, accuracy: 1 });
    expect(alignment.compatibility).toEqual({ evaluated: 1, correct: 1, accuracy: 1 });
    expect(alignment.resolution).toEqual({ evaluated: 1, correct: 0, accuracy: 0 });
    expect(alignment.pairs[0]).toMatchObject({ expected_id: "helium-gold", actual_id: "not-the-gold-id" });
  });

  it("leaves undefined Base Item outcomes unscored and never accepts an arbitrary match", () => {
    const suggestion = semanticSuggestion([
      { requirementId: "actual-rose", semanticKey: "rose", candidates: [99], selected: 99 },
    ]);
    const alignment = alignRecipeSemantics(suggestion, {
      lines: [{ id: "undefined-gold", semanticKey: "rose", acceptableBaseItemIds: [], quantity: 1 }],
      hiddenRules: [],
    });
    expect(alignment.resolution).toEqual({ evaluated: 0, correct: 0, accuracy: null });

    const record = benchmarkRecord(product({ id: 904 }));
    record.suggestion = suggestion;
    record.annotation = {
      productId: record.product.id,
      status: "canonical",
      finalRecipe: {
        disposition: "complete",
        acceptableVariants: [{
          lines: [{ id: "undefined-gold", semanticKey: "rose", acceptableBaseItemIds: [], quantity: 1 }],
          hiddenRules: [],
        }],
      },
    };
    const metrics = buildRecipeBenchmarkMetrics([record]) as any;
    expect(metrics.canonical_metrics.resolution_accuracy).toEqual({ evaluated: 0, correct: 0, accuracy: null });
    expect(metrics.canonical_metrics.full_recipe_exact_match).toEqual({ evaluated: 0, correct: 0, accuracy: null });
    expect(metrics.canonical_metrics.per_product[0].full_recipe_exact).toBeNull();
  });

  it("scores a definitive expected no-match without requiring an allowed Base Item", () => {
    const suggestion = semanticSuggestion([
      { requirementId: "actual-gap", semanticKey: "catalog-gap", candidates: [], selected: 99 },
    ]);
    suggestion.requirements[0].resolution = "no_match";
    suggestion.lines = [];
    const record = benchmarkRecord(product({ id: 905 }));
    record.suggestion = suggestion;
    record.annotation = {
      productId: record.product.id,
      status: "canonical",
      finalRecipe: {
        disposition: "complete",
        acceptableVariants: [{
          lines: [{
            id: "gold-gap",
            semanticKey: "catalog-gap",
            acceptableBaseItemIds: [],
            expectedResolutionOutcome: "no_match",
            quantity: 1,
          }],
          hiddenRules: [],
        }],
      },
    };

    const metrics = buildRecipeBenchmarkMetrics([record]) as any;
    expect(metrics.canonical_metrics.resolution_accuracy).toEqual({ evaluated: 1, correct: 1, accuracy: 1 });
    expect(metrics.canonical_metrics.full_recipe_exact_match).toEqual({ evaluated: 1, correct: 1, accuracy: 1 });
  });

  it("never reports exact success for partial catalog coverage", () => {
    const record = benchmarkRecord(product({ id: 906 }));
    record.suggestion = semanticSuggestion([
      { requirementId: "actual-rose", semanticKey: "rose", candidates: [1], selected: 1 },
    ]);
    record.annotation = {
      productId: record.product.id,
      status: "canonical",
      finalRecipe: {
        disposition: "partial_catalog_coverage",
        acceptableVariants: [{
          lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1], quantity: 1 }],
          hiddenRules: [],
        }],
      },
    };

    const metrics = buildRecipeBenchmarkMetrics([record]) as any;
    expect(metrics.canonical_metrics.resolution_accuracy).toEqual({ evaluated: 1, correct: 1, accuracy: 1 });
    expect(metrics.canonical_metrics.full_recipe_exact_match).toEqual({ evaluated: 0, correct: 0, accuracy: null });
    expect(metrics.canonical_metrics.unscored_final_recipe.products).toContainEqual({
      product_id: 906,
      reason: "partial_catalog_coverage_has_no_complete_acceptable_final_variant",
    });
  });

  it("allows an explicitly complete acceptable variant inside otherwise partial coverage", () => {
    const record = benchmarkRecord(product({ id: 908 }));
    record.suggestion = semanticSuggestion([
      { requirementId: "actual-rose", semanticKey: "rose", candidates: [1], selected: 1 },
    ]);
    record.annotation = {
      productId: record.product.id,
      status: "canonical",
      finalRecipe: {
        disposition: "partial_catalog_coverage",
        acceptableVariants: [{
          disposition: "complete",
          lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1], quantity: 1 }],
          hiddenRules: [],
        }],
      },
    };

    expect((buildRecipeBenchmarkMetrics([record]) as any)
      .canonical_metrics.full_recipe_exact_match).toEqual({ evaluated: 1, correct: 1, accuracy: 1 });
  });

  it("reports requirement extraction precision, recall, missing, false-positive, and duplicate counts", () => {
    const record = benchmarkRecord(product());
    record.suggestion = semanticSuggestion([
      { requirementId: "actual-rose", semanticKey: "rose", candidates: [1], selected: 1 },
      { requirementId: "duplicate-rose", semanticKey: "rose", candidates: [1], selected: 1 },
      { requirementId: "extra-ribbon", semanticKey: "ribbon", candidates: [9], selected: 9 },
    ]);
    record.annotation!.acceptableVariants = [{
      id: "annotated",
      lines: [
        {
          id: "gold-rose",
          semanticKey: "rose",
          sourceField: "description",
          sourceOccurrence: 0,
          acceptableBaseItemIds: [1],
        },
        {
          id: "gold-lily",
          semanticKey: "lily",
          sourceField: "description",
          sourceOccurrence: 3,
          acceptableBaseItemIds: [2],
        },
      ],
    }];

    const metrics = buildRecipeBenchmarkMetrics([record]) as any;
    expect(metrics.canonical.semantic_requirement_extraction).toMatchObject({
      definitive_expected_gold_requirements: 2,
      unambiguously_aligned_extracted_requirements: 1,
      missing_gold_requirements: 1,
      unmatched_extracted_requirements: 2,
      false_positive_extracted_requirements: 2,
      duplicate_extraction: 1,
      ambiguous_alignment: 0,
      extraction_precision: { evaluated: 3, correct: 1, accuracy: 0.3333 },
      extraction_recall: { evaluated: 2, correct: 1, accuracy: 0.5 },
    });
    expect(metrics.canonical.semantic_requirement_extraction.per_product[0]).toMatchObject({
      product_id: record.product.id,
      missing_gold_requirements: ["gold-lily"],
      unmatched_extracted_requirements: ["duplicate-rose", "extra-ribbon"],
      duplicate_extraction: ["duplicate-rose"],
    });
  });

  it("attributes each failed requirement to the earliest applicable failure stage", () => {
    const retrieval = benchmarkRecord(product({ id: 901 }));
    retrieval.suggestion = semanticSuggestion([
      { requirementId: "retrieval-actual", semanticKey: "rose", candidates: [99], selected: 99 },
    ]);
    retrieval.annotation!.acceptableVariants = [{
      lines: [{
        id: "retrieval-gold",
        semanticKey: "rose",
        acceptableBaseItemIds: [1],
        retrievalRelevantBaseItemIds: [1],
      }],
    }];

    const compatibility = benchmarkRecord(product({ id: 902 }));
    compatibility.suggestion = semanticSuggestion([
      { requirementId: "compatibility-actual", semanticKey: "rose", candidates: [1], selected: 99 },
    ]);
    compatibility.suggestion.requirements[0].candidateBaseItemIds = [];
    compatibility.suggestion.requirements[0].candidateCompatibility = [{
      baseItemId: 1,
      attributes: {},
      comparisons: {},
      hardExclusions: ["color"],
      hasUnknownExplicitDiscriminator: false,
      survivor: false,
    }];
    compatibility.annotation!.acceptableVariants = [{
      lines: [{
        id: "compatibility-gold",
        semanticKey: "rose",
        acceptableBaseItemIds: [1],
        retrievalRelevantBaseItemIds: [1],
      }],
    }];

    const missing = benchmarkRecord(product({ id: 903 }));
    missing.suggestion = semanticSuggestion([]);
    missing.annotation!.acceptableVariants = [{
      lines: [{ id: "missing-gold", semanticKey: "lily", acceptableBaseItemIds: [2] }],
    }];

    const metrics = buildRecipeBenchmarkMetrics([retrieval, compatibility, missing]) as any;
    expect(metrics.canonical.failure_stage_taxonomy.counts).toMatchObject({
      extraction_failure: 1,
      candidate_retrieval_failure: 1,
      compatibility_exclusion_failure: 1,
      base_item_resolution_failure: 0,
    });
    expect(metrics.canonical.failure_stage_taxonomy.affected_requirements).toMatchObject({
      extraction_failure: [expect.objectContaining({
        product_id: 903,
        expected_requirement_id: "missing-gold",
      })],
      candidate_retrieval_failure: [expect.objectContaining({
        product_id: 901,
        expected_requirement_id: "retrieval-gold",
      })],
      compatibility_exclusion_failure: [expect.objectContaining({
        product_id: 902,
        expected_requirement_id: "compatibility-gold",
      })],
    });
  });

  it("reports compatible, incompatible, and unknown candidate outcomes with explicit denominators", () => {
    const suggestion = semanticSuggestion([
      { requirementId: "rose", semanticKey: "rose", candidates: [70, 71, 72], selected: 70 },
    ]);
    suggestion.requirements[0].candidateCompatibility = [
      { baseItemId: 70, attributes: {}, comparisons: {}, hardExclusions: [], hasUnknownExplicitDiscriminator: false, survivor: true },
      { baseItemId: 71, attributes: {}, comparisons: {}, hardExclusions: ["color"], hasUnknownExplicitDiscriminator: false, survivor: false },
      { baseItemId: 72, attributes: {}, comparisons: {}, hardExclusions: [], hasUnknownExplicitDiscriminator: true, survivor: true },
    ];
    const alignment = alignRecipeSemantics(suggestion, {
      lines: [{
        semanticKey: "rose",
        acceptableBaseItemIds: [70],
        retrievalRelevantBaseItemIds: [70],
        knownIncompatibleBaseItemIds: [71],
        knownUnknownBaseItemIds: [72],
        quantity: 1,
      }],
    });

    expect(alignment.compatibility).toEqual({ evaluated: 3, correct: 3, accuracy: 1 });
    expect(alignment.compatibility_breakdown).toEqual({
      allowed_survival: { evaluated: 1, correct: 1, accuracy: 1 },
      known_incompatible_exclusion: { evaluated: 1, correct: 1, accuracy: 1 },
      expected_unknown_survival: { evaluated: 1, correct: 1, accuracy: 1 },
    });
  });

  it("scores Sponge and Metal Ring as separate governed hidden requirements", () => {
    const record = benchmarkRecord(product());
    record.suggestion.lines.push(
      {
        baseItemId: 80, baseItemName: "Sponge", quantity: 1, confidence: "high",
        source: "deterministic_rule", reason: "fixture", hiddenRuleKey: "flower_box_round_red_sponge",
        unresolved: false,
      },
      {
        baseItemId: 81, baseItemName: "Metal Ring", quantity: 1, confidence: "high",
        source: "deterministic_rule", reason: "fixture", hiddenRuleKey: "balloon_metal_ring",
        unresolved: false,
      },
    );
    record.annotation!.hiddenRules = [
      { ruleKey: "flower_box_sponge", expected: true, acceptableBaseItemIds: [80] },
      { ruleKey: "balloon_metal_ring", expected: true, acceptableBaseItemIds: [81] },
    ];

    expect(buildRecipeBenchmarkMetrics([record]).hidden_rule_accuracy)
      .toMatchObject({
        evaluated: 2,
        correct: 2,
        accuracy: 1,
        by_rule: {
          flower_box_sponge: { evaluated: 1, correct: 1 },
          balloon_metal_ring: { evaluated: 1, correct: 1 },
        },
      });
  });

  it("includes governed hidden requirements in semantic full-Recipe exactness", () => {
    const record = benchmarkRecord(product({ id: 907 }));
    record.suggestion = semanticSuggestion([
      { requirementId: "actual-rose", semanticKey: "rose", candidates: [1], selected: 1, quantity: 20 },
    ]);
    record.annotation = {
      productId: record.product.id,
      status: "canonical",
      finalRecipe: {
        disposition: "complete",
        acceptableVariants: [{
          id: "with-sponge",
          lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1], quantity: 20 }],
          hiddenRules: [{ ruleKey: "flower_box_sponge", expected: true, acceptableBaseItemIds: [80] }],
        }],
      },
      hiddenRules: [{ ruleKey: "flower_box_sponge", expected: true, acceptableBaseItemIds: [80] }],
    };

    expect((buildRecipeBenchmarkMetrics([record]) as any)
      .canonical_metrics.full_recipe_exact_match).toEqual({ evaluated: 1, correct: 0, accuracy: 0 });

    record.suggestion.lines.push({
      baseItemId: 80, baseItemName: "Sponge", quantity: 1, confidence: "high",
      source: "deterministic_rule", reason: "fixture", hiddenRuleKey: "flower_box_round_red_sponge",
      unresolved: false,
    });
    expect((buildRecipeBenchmarkMetrics([record]) as any)
      .canonical_metrics.full_recipe_exact_match).toEqual({ evaluated: 1, correct: 1, accuracy: 1 });

    record.suggestion.lines.push({ ...record.suggestion.lines[1] });
    const duplicate = buildRecipeBenchmarkMetrics([record]) as any;
    expect(duplicate.hidden_rule_accuracy).toMatchObject({ evaluated: 1, correct: 0, accuracy: 0 });
    expect(duplicate.canonical_metrics.full_recipe_exact_match)
      .toEqual({ evaluated: 1, correct: 0, accuracy: 0 });

    record.suggestion.lines[2].baseItemId = 81;
    const correctPlusWrong = buildRecipeBenchmarkMetrics([record]) as any;
    expect(correctPlusWrong.hidden_rule_accuracy).toMatchObject({ evaluated: 1, correct: 0, accuracy: 0 });
    expect(correctPlusWrong.canonical_metrics.full_recipe_exact_match)
      .toEqual({ evaluated: 1, correct: 0, accuracy: 0 });
    record.suggestion.lines.pop();

    record.suggestion.lines[1].baseItemId = 81;
    expect((buildRecipeBenchmarkMetrics([record]) as any)
      .canonical_metrics.full_recipe_exact_match).toEqual({ evaluated: 1, correct: 0, accuracy: 0 });

    record.annotation.finalRecipe!.acceptableVariants[0].hiddenRules = [
      { ruleKey: "balloon_metal_ring", expected: false },
    ];
    record.annotation.hiddenRules = [{ ruleKey: "balloon_metal_ring", expected: false }];
    record.suggestion.lines[1] = {
      ...record.suggestion.lines[1],
      baseItemId: 81,
      baseItemName: "Metal Ring",
      hiddenRuleKey: "balloon_metal_ring",
    };
    expect((buildRecipeBenchmarkMetrics([record]) as any)
      .canonical_metrics.full_recipe_exact_match).toEqual({ evaluated: 1, correct: 0, accuracy: 0 });
  });

  it("scores authoritative format, conflict handling, and contextual resolution from annotation gold", () => {
    const record = benchmarkRecord(product());
    record.suggestion = semanticSuggestion([
      { requirementId: "actual-rose", semanticKey: "rose", candidates: [1], selected: 1 },
    ]);
    const structure = benchmarkRecord(product()).suggestion.structure;
    record.suggestion.structure = structure;
    record.suggestion.contextualRuleDiagnostics = [{
      ruleId: 7,
      ruleKey: "red-rose-flower-box-40cm",
      resolverBaseItemId: 1,
      canonicalFormats: ["Flower Box"],
      authoritativePrimaryFormat: "Flower Box",
      outcome: "applied",
      reason: "fixture",
      requirementId: "actual-rose",
      preserved: {
        quantity: 1,
        unit: null,
        evidence: evidence(0),
        additionalEvidence: [],
        provenance: [evidence(0)],
      },
      independentlyVerifiedGovernedValue: 40,
    }];
    record.annotation!.acceptableVariants = [{
      lines: [{
        id: "gold-rose",
        semanticKey: "rose",
        acceptableBaseItemIds: [1],
        contextualRuleKey: "red-rose-flower-box-40cm",
      }],
    }];
    record.annotation!.formatExpectation = {
      authoritativeProductFormat: "Flower Box",
      conflictExpected: false,
      expectedResolvedPrimaryFormat: "Flower Box",
    };
    record.annotation!.contextualResolvers = [{
      requirementId: "gold-rose",
      ruleKey: "red-rose-flower-box-40cm",
      expectedOutcome: "applied",
      expectedBaseItemId: 1,
    }];

    expect((buildRecipeBenchmarkMetrics([record]) as any).canonical.format_and_context_accuracy)
      .toEqual({
        authoritative_product_format: { evaluated: 1, correct: 1, accuracy: 1 },
        format_conflict_handling: { evaluated: 1, correct: 1, accuracy: 1 },
        resolved_primary_format: { evaluated: 1, correct: 1, accuracy: 1 },
        contextual_resolver: { evaluated: 1, correct: 1, accuracy: 1 },
      });
  });

  it("keeps drafts provisional-only and fingerprints canonical and provisional gold independently", () => {
    const canonical = benchmarkRecord(product({ id: 1 }));
    canonical.annotation!.status = "canonical";
    const draft = benchmarkRecord(product({ id: 2 }));
    draft.annotation!.status = "draft";
    draft.annotation!.note = "first draft";
    draft.annotation!.finalRecipe = {
      disposition: "complete",
      acceptableVariants: [{
        lines: [{ phrase: "red rose", quantity: 20, acceptableBaseItemIds: [1] }],
        hiddenRules: [{ ruleKey: "flower_box_sponge", expected: true, acceptableBaseItemIds: [80] }],
      }],
    };
    const first = buildRecipeBenchmarkMetrics([canonical, draft]) as any;
    draft.annotation!.note = "changed draft";
    const provenanceOnly = buildRecipeBenchmarkMetrics([draft, canonical]) as any;
    draft.annotation!.finalRecipe.acceptableVariants[0].hiddenRules![0].expectedCount = 2;
    const second = buildRecipeBenchmarkMetrics([draft, canonical]) as any;

    expect(first.denominators).toMatchObject({ canonical_products: 1, provisional_products: 1 });
    expect(first.canonical.product_count).toBe(1);
    expect(first.provisional.product_count).toBe(1);
    expect(second.annotation_fingerprints.canonical).toBe(first.annotation_fingerprints.canonical);
    expect(provenanceOnly.annotation_fingerprints.provisional).toBe(first.annotation_fingerprints.provisional);
    expect(second.annotation_fingerprints.provisional).not.toBe(first.annotation_fingerprints.provisional);
    expect(second.regression_gate_inputs.annotation_fingerprint).toBe(first.regression_gate_inputs.annotation_fingerprint);
  });

  it("fingerprints only scoring-relevant annotation fields", () => {
    const record = benchmarkRecord(product());
    record.annotation!.finalRecipe = {
      disposition: "complete",
      acceptableVariants: [{
        lines: [{ phrase: "red rose", quantity: 20, acceptableBaseItemIds: [1] }],
        hiddenRules: [{ ruleKey: "flower_box_sponge", expected: true, acceptableBaseItemIds: [80] }],
        provenance: { source: "first reviewer wording" },
      }],
    };
    const first = recipeBenchmarkAnnotationScoringProjection(record.annotation!);
    record.annotation!.note = "rewritten audit note";
    record.annotation!.provenance = { source: "different reviewer wording" };
    record.annotation!.finalRecipe.acceptableVariants[0].provenance = { source: "different evidence wording" };
    const auditOnlyEdit = recipeBenchmarkAnnotationScoringProjection(record.annotation!);
    record.annotation!.finalRecipe.acceptableVariants[0].hiddenRules![0].expectedCount = 2;
    const hiddenRuleEdit = recipeBenchmarkAnnotationScoringProjection(record.annotation!);
    record.annotation!.finalRecipe.acceptableVariants[0].hiddenRules![0].expectedCount = undefined;
    record.annotation!.finalRecipe.acceptableVariants[0].disposition = "partial_catalog_coverage";
    const variantDispositionEdit = recipeBenchmarkAnnotationScoringProjection(record.annotation!);
    record.annotation!.finalRecipe.acceptableVariants[0].disposition = undefined;
    record.annotation!.finalRecipe.disposition = "partial_catalog_coverage";
    const finalDispositionEdit = recipeBenchmarkAnnotationScoringProjection(record.annotation!);

    expect(auditOnlyEdit).toEqual(first);
    expect(hiddenRuleEdit).not.toEqual(first);
    expect(variantDispositionEdit).not.toEqual(first);
    expect(finalDispositionEdit).not.toEqual(first);
  });

  it("chooses the acceptable variant with the best complete scoring outcome, not the smallest ID", () => {
    const record = benchmarkRecord(product());
    record.suggestion = semanticSuggestion([
      { requirementId: "rose", semanticKey: "red rose", candidates: [1], selected: 1, quantity: 20 },
    ]);
    record.annotation!.acceptableVariants = [
      { id: "a-wrong-quantity", lines: [{ phrase: "red rose", quantity: 99, acceptableBaseItemIds: [1] }] },
      { id: "z-correct-quantity", lines: [{ phrase: "red rose", quantity: 20, acceptableBaseItemIds: [1] }] },
    ];
    record.annotation!.hiddenRules = [];

    const metrics = buildRecipeBenchmarkMetrics([record]) as any;

    expect(metrics.canonical_metrics.full_recipe_exact_match).toEqual({
      evaluated: 1,
      correct: 1,
      accuracy: 1,
    });
    expect(metrics.canonical_metrics.per_product[0].selected_variant_id).toBe("z-correct-quantity");
  });

  it("selects variants by hidden-rule outcome independent of order and prefers complete eligibility", () => {
    const record = benchmarkRecord(product({ id: 909 }));
    record.suggestion = semanticSuggestion([
      { requirementId: "rose", semanticKey: "red rose", candidates: [1], selected: 1, quantity: 20 },
    ]);
    record.suggestion.lines.push({
      baseItemId: 80, baseItemName: "Sponge", quantity: 1, confidence: "high",
      source: "deterministic_rule", reason: "fixture", hiddenRuleKey: "flower_box_round_red_sponge",
      unresolved: false,
    });
    const semanticLine = { phrase: "red rose", quantity: 20, acceptableBaseItemIds: [1] };
    const withoutSponge = {
      id: "without-sponge",
      disposition: "complete" as const,
      lines: [semanticLine],
      hiddenRules: [{ ruleKey: "flower_box_sponge", expected: false }],
    };
    const withSponge = {
      id: "with-sponge",
      disposition: "complete" as const,
      lines: [semanticLine],
      hiddenRules: [{ ruleKey: "flower_box_sponge", expected: true, acceptableBaseItemIds: [80] }],
    };
    record.annotation = {
      productId: record.product.id,
      status: "canonical",
      finalRecipe: { disposition: "complete", acceptableVariants: [withoutSponge, withSponge] },
    };

    const forward = buildRecipeBenchmarkMetrics([record]) as any;
    expect(forward.canonical_metrics.per_product[0]).toMatchObject({
      selected_variant_id: "with-sponge",
      alignment_ambiguous: false,
      full_recipe_exact: true,
    });

    record.annotation.finalRecipe!.acceptableVariants.reverse();
    const reversed = buildRecipeBenchmarkMetrics([record]) as any;
    expect(reversed.canonical_metrics.per_product[0]).toMatchObject({
      selected_variant_id: "with-sponge",
      alignment_ambiguous: false,
      full_recipe_exact: true,
    });

    record.annotation.finalRecipe!.acceptableVariants = [
      { ...withSponge, id: "partial", disposition: "partial_catalog_coverage" },
      { ...withSponge, id: "complete", disposition: "complete" },
    ];
    const eligible = buildRecipeBenchmarkMetrics([record]) as any;
    expect(eligible.canonical_metrics.per_product[0]).toMatchObject({
      selected_variant_id: "complete",
      alignment_ambiguous: false,
      full_recipe_exact: true,
    });
  });

  it("keeps compatibility ranking ahead of variant-specific hidden-rule evidence", () => {
    const record = benchmarkRecord(product({ id: 910 }));
    record.suggestion = semanticSuggestion([
      { requirementId: "rose", semanticKey: "red rose", candidates: [1, 2], selected: 1, quantity: 20 },
    ]);
    record.suggestion.requirements[0].candidateCompatibility = [
      {
        baseItemId: 1, attributes: {}, comparisons: {}, hardExclusions: [],
        hasUnknownExplicitDiscriminator: false, survivor: true,
      },
      {
        baseItemId: 2, attributes: {}, comparisons: {}, hardExclusions: [],
        hasUnknownExplicitDiscriminator: false, survivor: true,
      },
    ];
    record.suggestion.lines.push({
      baseItemId: 80, baseItemName: "Sponge", quantity: 1, confidence: "high",
      source: "deterministic_rule", reason: "fixture", hiddenRuleKey: "flower_box_round_red_sponge",
      unresolved: false,
    });
    const semanticLine = { phrase: "red rose", quantity: 20, acceptableBaseItemIds: [1] };
    record.annotation = {
      productId: record.product.id,
      status: "canonical",
      finalRecipe: {
        disposition: "complete",
        acceptableVariants: [
          {
            id: "compatibility-correct-hidden-wrong",
            lines: [semanticLine],
            hiddenRules: [{ ruleKey: "flower_box_sponge", expected: false }],
          },
          {
            id: "compatibility-wrong-hidden-correct",
            lines: [{ ...semanticLine, knownIncompatibleBaseItemIds: [2] }],
            hiddenRules: [{
              ruleKey: "flower_box_sponge", expected: true, acceptableBaseItemIds: [80],
            }],
          },
        ],
      },
    };

    expect((buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics.per_product[0])
      .toMatchObject({
        selected_variant_id: "compatibility-correct-hidden-wrong",
        alignment_ambiguous: false,
        compatibility: { evaluated: 1, correct: 1, accuracy: 1 },
        full_recipe_exact: false,
      });
  });

  it("audits every final line and gates exactness on stable requirement lineage", () => {
    const valid = exactSemanticRecord(920);
    const validMetrics = buildRecipeBenchmarkMetrics([valid]) as any;
    expect(validMetrics.canonical_metrics.full_recipe_exact_match)
      .toEqual({ evaluated: 1, correct: 1, accuracy: 1 });
    expect(validMetrics.canonical_metrics.final_line_lineage_safety).toMatchObject({
      unsupported_final_lines: { count: 0 },
      dangling_requirement_lines: { count: 0 },
      missing_or_invalid_requirement_provenance: { count: 0 },
    });

    const unsupported = exactSemanticRecord(921);
    unsupported.suggestion.lines.push({
      ...unsupported.suggestion.lines[0],
      baseItemId: 2,
      requirementId: null,
      requirementProvenance: null,
    });
    const unsupportedMetrics = buildRecipeBenchmarkMetrics([unsupported]) as any;
    expect(unsupportedMetrics.canonical_metrics.full_recipe_exact_match)
      .toEqual({ evaluated: 1, correct: 0, accuracy: 0 });
    expect(unsupportedMetrics.canonical_metrics.final_line_lineage_safety.unsupported_final_lines)
      .toMatchObject({
        count: 1,
        affected_product_ids: [921],
        affected_lines: [{ product_id: 921, base_item_id: 2, requirement_id: null }],
      });

    const dangling = exactSemanticRecord(922);
    dangling.suggestion.lines.push({
      ...dangling.suggestion.lines[0],
      baseItemId: 3,
      requirementId: "unknown-requirement",
    });
    const danglingMetrics = buildRecipeBenchmarkMetrics([dangling]) as any;
    expect(danglingMetrics.canonical_metrics.full_recipe_exact_match.correct).toBe(0);
    expect(danglingMetrics.canonical_metrics.final_line_lineage_safety.dangling_requirement_lines)
      .toMatchObject({
        count: 1,
        affected_lines: [{ product_id: 922, base_item_id: 3, requirement_id: "unknown-requirement" }],
      });

    const missingProvenance = exactSemanticRecord(923);
    missingProvenance.suggestion.lines[0].requirementProvenance = null;
    const missingMetrics = buildRecipeBenchmarkMetrics([missingProvenance]) as any;
    expect(missingMetrics.canonical_metrics.full_recipe_exact_match.correct).toBe(0);
    expect(missingMetrics.canonical_metrics.final_line_lineage_safety
      .missing_or_invalid_requirement_provenance).toMatchObject({
      count: 1,
      affected_lines: [{ product_id: 923, base_item_id: 1, requirement_id: "actual-rose" }],
    });

    const staleProvenance = exactSemanticRecord(924);
    staleProvenance.suggestion.lines[0].requirementProvenance = {
      ...staleProvenance.suggestion.lines[0].requirementProvenance!,
      phrase: "stale rose evidence",
    };
    const staleMetrics = buildRecipeBenchmarkMetrics([staleProvenance]) as any;
    expect(staleMetrics.canonical_metrics.full_recipe_exact_match.correct).toBe(0);
    expect(staleMetrics.canonical_metrics.final_line_lineage_safety
      .missing_or_invalid_requirement_provenance.count).toBe(1);

    const wrongProvenance = exactSemanticRecord(927);
    wrongProvenance.suggestion.lines[0].requirementProvenance = {
      ...wrongProvenance.suggestion.lines[0].requirementProvenance!,
      requirementId: "different-requirement",
    };
    const wrongMetrics = buildRecipeBenchmarkMetrics([wrongProvenance]) as any;
    expect(wrongMetrics.canonical_metrics.full_recipe_exact_match.correct).toBe(0);
    expect(wrongMetrics.canonical_metrics.final_line_lineage_safety
      .missing_or_invalid_requirement_provenance.count).toBe(1);

    unsupported.annotation!.status = "draft";
    const provisionalMetrics = buildRecipeBenchmarkMetrics([unsupported]) as any;
    expect(provisionalMetrics.final_line_lineage_safety).toMatchObject({
      canonical: { unsupported_final_lines: { count: 0 } },
      provisional: { unsupported_final_lines: { count: 1 } },
    });
  });

  it("preserves unscored exactness precedence while still reporting lineage failures", () => {
    const ambiguous = exactSemanticRecord(928);
    ambiguous.annotation!.finalRecipe!.acceptableVariants.push({
      ...ambiguous.annotation!.finalRecipe!.acceptableVariants[0],
      id: "equally-valid",
    });
    ambiguous.suggestion.lines.push({
      ...ambiguous.suggestion.lines[0],
      baseItemId: 2,
      requirementId: null,
      requirementProvenance: null,
    });
    const ambiguousMetrics = (buildRecipeBenchmarkMetrics([ambiguous]) as any).canonical_metrics;
    expect(ambiguousMetrics.full_recipe_exact_match)
      .toEqual({ evaluated: 0, correct: 0, accuracy: null });
    expect(ambiguousMetrics.final_line_lineage_safety.unsupported_final_lines.count).toBe(1);

    const partial = exactSemanticRecord(929);
    partial.annotation!.finalRecipe!.disposition = "partial_catalog_coverage";
    partial.suggestion.lines.push({
      ...partial.suggestion.lines[0],
      baseItemId: 2,
      requirementId: null,
      requirementProvenance: null,
    });
    const partialMetrics = (buildRecipeBenchmarkMetrics([partial]) as any).canonical_metrics;
    expect(partialMetrics.full_recipe_exact_match)
      .toEqual({ evaluated: 0, correct: 0, accuracy: null });
    expect(partialMetrics.final_line_lineage_safety.unsupported_final_lines.count).toBe(1);

    const definitive = exactSemanticRecord(937);
    definitive.suggestion.lines.push({
      ...definitive.suggestion.lines[0],
      baseItemId: 2,
      requirementId: null,
      requirementProvenance: null,
    });
    expect((buildRecipeBenchmarkMetrics([definitive]) as any)
      .canonical_metrics.full_recipe_exact_match)
      .toEqual({ evaluated: 1, correct: 0, accuracy: 0 });
  });

  it("exempts only recognized governed operational lines from requirement lineage", () => {
    const governed = exactSemanticRecord(925);
    governed.suggestion.lines.push(
      {
        baseItemId: 80, baseItemName: "Sponge", quantity: 1, confidence: "high",
        source: "deterministic_rule", reason: "fixture",
        hiddenRuleKey: "flower_box_round_red_sponge", unresolved: false,
      },
      {
        baseItemId: 81, baseItemName: "Metal Ring", quantity: 1, confidence: "high",
        source: "deterministic_rule", reason: "fixture",
        hiddenRuleKey: "balloon_metal_ring", unresolved: false,
      },
    );
    governed.annotation!.finalRecipe!.acceptableVariants[0].hiddenRules = [
      { ruleKey: "flower_box_sponge", expected: true, acceptableBaseItemIds: [80] },
      { ruleKey: "balloon_metal_ring", expected: true, acceptableBaseItemIds: [81] },
    ];
    const governedMetrics = buildRecipeBenchmarkMetrics([governed]) as any;
    expect(governedMetrics.canonical_metrics.full_recipe_exact_match)
      .toEqual({ evaluated: 1, correct: 1, accuracy: 1 });
    expect(governedMetrics.canonical_metrics.final_line_lineage_safety).toMatchObject({
      unsupported_final_lines: { count: 0 },
      dangling_requirement_lines: { count: 0 },
      missing_or_invalid_requirement_provenance: { count: 0 },
    });

    const fake = exactSemanticRecord(926);
    fake.suggestion.lines.push({
      baseItemId: 82, baseItemName: "Fake Hidden", quantity: 1, confidence: "high",
      source: "deterministic_rule", reason: "fixture",
      hiddenRuleKey: "fake_operational_rule", unresolved: false,
    });
    const fakeMetrics = buildRecipeBenchmarkMetrics([fake]) as any;
    expect(fakeMetrics.canonical_metrics.full_recipe_exact_match.correct).toBe(0);
    expect(fakeMetrics.canonical_metrics.final_line_lineage_safety.unsupported_final_lines)
      .toMatchObject({
        count: 1,
        affected_lines: [{ product_id: 926, base_item_id: 82, requirement_id: null }],
      });
  });

  it("reports perfect semantic Base Item precision, recall, and F1", () => {
    const metrics = buildRecipeBenchmarkMetrics([exactSemanticRecord(930)]) as any;
    expect(metrics.canonical_metrics.base_item_resolution).toMatchObject({
      definitive_positive_gold_requirements: 1,
      resolved_semantic_predictions: 1,
      correctly_resolved_allowed_base_item_matches: 1,
      incorrectly_resolved_semantic_lines: 0,
      missed_or_unresolved_positive_requirements: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    });
  });

  it("separates wrong and missed positive Base Item resolutions", () => {
    const wrong = exactSemanticRecord(931);
    wrong.suggestion.requirements[0].preCompatibilityCandidateBaseItemIds = [1, 2];
    wrong.suggestion.requirements[0].candidateBaseItemIds = [1, 2];
    wrong.suggestion.lines[0].baseItemId = 2;
    wrong.suggestion.lines[0].requirementProvenance = {
      ...wrong.suggestion.lines[0].requirementProvenance!,
      candidateBaseItemIds: [1, 2],
      preCompatibilityCandidateBaseItemIds: [1, 2],
    };
    const wrongMetric = (buildRecipeBenchmarkMetrics([wrong]) as any)
      .canonical_metrics.base_item_resolution;
    expect(wrongMetric).toMatchObject({
      resolved_semantic_predictions: 1,
      correctly_resolved_allowed_base_item_matches: 0,
      incorrectly_resolved_semantic_lines: 1,
      missed_or_unresolved_positive_requirements: 0,
      precision: 0,
      recall: 0,
      f1: 0,
    });

    const missed = exactSemanticRecord(932);
    missed.suggestion.lines = [];
    missed.suggestion.requirements[0].resolution = "no_match";
    const missedMetric = (buildRecipeBenchmarkMetrics([missed]) as any)
      .canonical_metrics.base_item_resolution;
    expect(missedMetric).toMatchObject({
      resolved_semantic_predictions: 0,
      correctly_resolved_allowed_base_item_matches: 0,
      incorrectly_resolved_semantic_lines: 0,
      missed_or_unresolved_positive_requirements: 1,
      no_match_outcomes: 1,
      precision: null,
      recall: 0,
      f1: 0,
    });
  });

  it("counts an unmatched resolved semantic line as a Base Item false positive", () => {
    const record = exactSemanticRecord(933);
    record.suggestion = semanticSuggestion([
      { requirementId: "actual-rose", semanticKey: "rose", candidates: [1], selected: 1, quantity: 20 },
      { requirementId: "actual-vase", semanticKey: "vase", candidates: [2], selected: 2 },
    ]);
    const metric = (buildRecipeBenchmarkMetrics([record]) as any)
      .canonical_metrics.base_item_resolution;
    expect(metric).toMatchObject({
      definitive_positive_gold_requirements: 1,
      resolved_semantic_predictions: 2,
      correctly_resolved_allowed_base_item_matches: 1,
      incorrectly_resolved_semantic_lines: 1,
      false_positive_resolved_semantic_lines: 1,
      precision: 0.5,
      recall: 1,
      f1: 0.6667,
    });
  });

  it("keeps expected ambiguity, no-match, and undefined Base Item gold outside P/R/F1", () => {
    const record = exactSemanticRecord(934);
    record.suggestion = semanticSuggestion([
      { requirementId: "positive", semanticKey: "rose", candidates: [1], selected: 1 },
      { requirementId: "ambiguous", semanticKey: "ribbon", candidates: [2, 3], selected: 2 },
      { requirementId: "no-match", semanticKey: "card", candidates: [], selected: 3 },
      { requirementId: "undefined", semanticKey: "wrapper", candidates: [4], selected: 4 },
    ]);
    record.suggestion.requirements[1].resolution = "ambiguous";
    record.suggestion.requirements[2].resolution = "no_match";
    record.suggestion.lines = record.suggestion.lines.filter((line) =>
      line.requirementId !== "ambiguous" && line.requirementId !== "no-match");
    record.annotation!.finalRecipe!.acceptableVariants[0].lines = [
      { semanticKey: "rose", acceptableBaseItemIds: [1], quantity: 1 },
      { semanticKey: "ribbon", expectedResolutionOutcome: "ambiguous", acceptableBaseItemIds: [] },
      { semanticKey: "card", expectedResolutionOutcome: "no_match", acceptableBaseItemIds: [] },
      { semanticKey: "wrapper", acceptableBaseItemIds: [] },
    ];
    const metric = (buildRecipeBenchmarkMetrics([record]) as any)
      .canonical_metrics.base_item_resolution;
    expect(metric).toMatchObject({
      definitive_positive_gold_requirements: 1,
      resolved_semantic_predictions: 1,
      correctly_resolved_allowed_base_item_matches: 1,
      expected_ambiguous_outcomes_excluded: 1,
      expected_no_match_outcomes_excluded: 1,
      undefined_base_item_gold_requirements_unscored: 1,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    expect((buildRecipeBenchmarkMetrics([record]) as any).canonical_format_groups[0])
      .toMatchObject({
        base_item_precision: 1,
        base_item_recall: 1,
        base_item_f1: 1,
      });
  });

  it("keeps definitive semantic gold in failed and unsupported generation denominators", () => {
    const perfect = exactSemanticRecord(938);
    const failed = exactSemanticRecord(939);
    failed.generationStatus = "failed";
    const canonical = (buildRecipeBenchmarkMetrics([perfect, failed]) as any).canonical_metrics;
    expect(canonical.base_item_resolution).toMatchObject({
      definitive_positive_gold_requirements: 2,
      resolved_semantic_predictions: 1,
      correctly_resolved_allowed_base_item_matches: 1,
      missed_or_unresolved_positive_requirements: 1,
      precision: 1,
      recall: 0.5,
      f1: 0.6667,
    });
    expect(canonical.semantic_requirement_extraction).toMatchObject({
      definitive_expected_gold_requirements: 2,
      unambiguously_aligned_extracted_requirements: 1,
      missing_gold_requirements: 1,
      extraction_recall: { evaluated: 2, correct: 1, accuracy: 0.5 },
    });

    const unsupported = exactSemanticRecord(940);
    unsupported.annotation!.status = "draft";
    unsupported.generationStatus = "unsupported";
    const provisional = (buildRecipeBenchmarkMetrics([unsupported]) as any).provisional_metrics;
    expect(provisional.base_item_resolution).toMatchObject({
      definitive_positive_gold_requirements: 1,
      missed_or_unresolved_positive_requirements: 1,
      precision: null,
      recall: 0,
      f1: 0,
    });
    expect(provisional.semantic_requirement_extraction.extraction_recall)
      .toEqual({ evaluated: 1, correct: 0, accuracy: 0 });

    const undefinedGold = benchmarkRecord(product({ id: 941 }));
    undefinedGold.generationStatus = "failed";
    const undefinedMetrics = (buildRecipeBenchmarkMetrics([undefinedGold]) as any).canonical_metrics;
    expect(undefinedMetrics.base_item_resolution).toMatchObject({
      scored_products: 0,
      definitive_positive_gold_requirements: 0,
      precision: null,
      recall: null,
      f1: null,
    });
    expect(undefinedMetrics.semantic_requirement_extraction.extraction_recall)
      .toEqual({ evaluated: 0, correct: 0, accuracy: null });
  });

  it("treats reordered, differently identified variants as the same failed-generation semantic gold", () => {
    const record = exactSemanticRecord(944);
    const rose = {
      id: "rose-primary",
      requirementId: "gold-rose-primary",
      semanticKey: "rose",
      acceptableBaseItemIds: [1],
      quantity: 20,
    };
    const vase = {
      id: "vase-primary",
      requirementId: "gold-vase-primary",
      semanticKey: "vase",
      acceptableBaseItemIds: [2],
      quantity: 1,
    };
    record.annotation!.finalRecipe!.acceptableVariants = [
      { id: "ordered-a", lines: [rose, vase], hiddenRules: [] },
      {
        id: "ordered-b",
        lines: [
          { ...vase, id: "vase-alternate", requirementId: "gold-vase-alternate" },
          { ...rose, id: "rose-alternate", requirementId: "gold-rose-alternate" },
        ],
        hiddenRules: [],
      },
    ];
    record.generationStatus = "failed";

    const failed = (buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics;
    expect(failed.base_item_resolution).toMatchObject({
      scored_products: 1,
      definitive_positive_gold_requirements: 2,
      missed_or_unresolved_positive_requirements: 2,
      precision: null,
      recall: 0,
      f1: 0,
    });
    expect(failed.semantic_requirement_extraction).toMatchObject({
      definitive_expected_gold_requirements: 2,
      missing_gold_requirements: 2,
      extraction_recall: { evaluated: 2, correct: 0, accuracy: 0 },
    });

    record.annotation!.status = "provisional";
    record.generationStatus = "unsupported";
    const unsupported = (buildRecipeBenchmarkMetrics([record]) as any).provisional_metrics;
    expect(unsupported.base_item_resolution).toMatchObject({
      definitive_positive_gold_requirements: 2,
      missed_or_unresolved_positive_requirements: 2,
      recall: 0,
    });
    expect(unsupported.semantic_requirement_extraction.extraction_recall)
      .toEqual({ evaluated: 2, correct: 0, accuracy: 0 });
  });

  it("keeps failed extraction and Base Item gold when positive alternatives differ", () => {
    const record = exactSemanticRecord(945);
    record.annotation!.finalRecipe!.acceptableVariants = [
      {
        id: "base-item-a",
        lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1], quantity: 20 }],
        hiddenRules: [],
      },
      {
        id: "base-item-b",
        lines: [{ semanticKey: "rose", acceptableBaseItemIds: [2], quantity: 20 }],
        hiddenRules: [],
      },
    ];
    record.generationStatus = "failed";

    const metrics = (buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics;
    expect(metrics.semantic_requirement_extraction).toMatchObject({
      definitive_expected_gold_requirements: 1,
      missing_gold_requirements: 1,
      extraction_recall: { evaluated: 1, correct: 0, accuracy: 0 },
    });
    expect(metrics.base_item_resolution).toMatchObject({
      scored_products: 1,
      definitive_positive_gold_requirements: 1,
      missed_or_unresolved_positive_requirements: 1,
      recall: 0,
    });
  });

  it("keeps failed extraction and Base Item gold independent of quantity disagreement", () => {
    const record = exactSemanticRecord(946);
    record.annotation!.finalRecipe!.acceptableVariants = [
      {
        id: "quantity-20",
        lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1], quantity: 20, unit: "stem" }],
        hiddenRules: [],
      },
      {
        id: "quantity-24",
        lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1], quantity: 24, unit: "bunch" }],
        hiddenRules: [],
      },
    ];
    record.generationStatus = "failed";

    const metrics = (buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics;
    expect(metrics.semantic_requirement_extraction).toMatchObject({
      definitive_expected_gold_requirements: 1,
      missing_gold_requirements: 1,
    });
    expect(metrics.base_item_resolution).toMatchObject({
      definitive_positive_gold_requirements: 1,
      missed_or_unresolved_positive_requirements: 1,
      recall: 0,
    });
    expect(metrics.quantity_accuracy).toEqual({ evaluated: 0, correct: 0, accuracy: null });
  });

  it("scores only shared failed-generation requirements across partial variant consensus", () => {
    const record = exactSemanticRecord(947);
    record.annotation!.finalRecipe!.acceptableVariants = [
      {
        id: "rose-and-vase",
        lines: [
          { semanticKey: "rose", acceptableBaseItemIds: [1] },
          { semanticKey: "vase", acceptableBaseItemIds: [2] },
        ],
        hiddenRules: [],
      },
      {
        id: "rose-and-box",
        lines: [
          { semanticKey: "rose", acceptableBaseItemIds: [1] },
          { semanticKey: "flower-box", acceptableBaseItemIds: [3] },
        ],
        hiddenRules: [],
      },
    ];
    record.generationStatus = "failed";

    const metrics = (buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics;
    expect(metrics.semantic_requirement_extraction).toMatchObject({
      definitive_expected_gold_requirements: 1,
      missing_gold_requirements: 1,
      extraction_recall: { evaluated: 1, correct: 0, accuracy: 0 },
    });
    expect(metrics.base_item_resolution).toMatchObject({
      definitive_positive_gold_requirements: 1,
      missed_or_unresolved_positive_requirements: 1,
      recall: 0,
    });
  });

  it("keeps shared extraction gold but excludes nondefinitive positive Base Item outcomes", () => {
    const alternatives: Array<[number, SemanticRecipeLine]> = [
      [948, { semanticKey: "rose", acceptableBaseItemIds: [], expectedResolutionOutcome: "no_match" }],
      [949, { semanticKey: "rose", acceptableBaseItemIds: [], expectedResolutionOutcome: "ambiguous" }],
      [950, { semanticKey: "rose", acceptableBaseItemIds: [] }],
    ];
    for (const [id, alternative] of alternatives) {
      const record = exactSemanticRecord(id);
      record.annotation!.finalRecipe!.acceptableVariants = [
        {
          id: "positive",
          lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1] }],
          hiddenRules: [],
        },
        { id: "non-positive", lines: [alternative], hiddenRules: [] },
      ];
      record.generationStatus = "failed";

      const metrics = (buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics;
      expect(metrics.semantic_requirement_extraction).toMatchObject({
        definitive_expected_gold_requirements: 1,
        missing_gold_requirements: 1,
        extraction_recall: { evaluated: 1, correct: 0, accuracy: 0 },
      });
      expect(metrics.base_item_resolution).toMatchObject({
        scored_products: 0,
        definitive_positive_gold_requirements: 0,
        missed_or_unresolved_positive_requirements: 0,
        precision: null,
        recall: null,
        f1: null,
      });
    }
  });

  it("does not fabricate failed-generation consensus from phrase containment", () => {
    const record = exactSemanticRecord(951);
    record.annotation!.finalRecipe!.acceptableVariants = [
      {
        id: "generic-rose",
        lines: [{ phrase: "rose", acceptableBaseItemIds: [1] }],
        hiddenRules: [],
      },
      {
        id: "qualified-red-rose",
        lines: [{ phrase: "red rose", acceptableBaseItemIds: [1] }],
        hiddenRules: [],
      },
    ];
    record.generationStatus = "failed";

    const metrics = (buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics;
    expect(metrics.semantic_requirement_extraction).toMatchObject({
      definitive_expected_gold_requirements: 0,
      missing_gold_requirements: 0,
      extraction_recall: { evaluated: 0, correct: 0, accuracy: null },
    });
    expect(metrics.base_item_resolution).toMatchObject({
      scored_products: 0,
      definitive_positive_gold_requirements: 0,
      missed_or_unresolved_positive_requirements: 0,
      precision: null,
      recall: null,
      f1: null,
    });
  });

  it("scores indistinguishable duplicate outcomes as an order-independent multiset", () => {
    const positive: SemanticRecipeLine = {
      id: "positive",
      semanticKey: "rose",
      acceptableBaseItemIds: [1],
    };
    const noMatch: SemanticRecipeLine = {
      id: "no-match",
      semanticKey: "rose",
      acceptableBaseItemIds: [],
      expectedResolutionOutcome: "no_match",
    };
    for (const [id, first, second] of [
      [952, [positive, noMatch], [positive, noMatch]],
      [953, [noMatch, positive], [positive, noMatch]],
      [954, [positive, noMatch], [noMatch, positive]],
      [955, [noMatch, positive], [noMatch, positive]],
    ] as Array<[number, SemanticRecipeLine[], SemanticRecipeLine[]]>) {
      const record = exactSemanticRecord(id);
      record.annotation!.finalRecipe!.acceptableVariants = [
        { id: "duplicate-a", lines: first, hiddenRules: [] },
        { id: "duplicate-b", lines: second, hiddenRules: [] },
      ];
      record.generationStatus = "failed";

      const metrics = (buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics;
      expect(metrics.semantic_requirement_extraction).toMatchObject({
        definitive_expected_gold_requirements: 2,
        missing_gold_requirements: 2,
        extraction_recall: { evaluated: 2, correct: 0, accuracy: 0 },
      });
      expect(metrics.base_item_resolution).toMatchObject({
        scored_products: 1,
        definitive_positive_gold_requirements: 1,
        missed_or_unresolved_positive_requirements: 1,
        expected_no_match_outcomes_excluded: 1,
        recall: 0,
      });
    }
  });

  it("keeps positive and undefined duplicate counts independent of line order", () => {
    const positive: SemanticRecipeLine = {
      semanticKey: "rose",
      acceptableBaseItemIds: [1],
    };
    const undefinedGold: SemanticRecipeLine = {
      semanticKey: "rose",
      acceptableBaseItemIds: [],
    };
    for (const [id, first, second] of [
      [956, [positive, undefinedGold], [undefinedGold, positive]],
      [957, [undefinedGold, positive], [positive, undefinedGold]],
    ] as Array<[number, SemanticRecipeLine[], SemanticRecipeLine[]]>) {
      const record = exactSemanticRecord(id);
      record.annotation!.finalRecipe!.acceptableVariants = [
        { id: "undefined-a", lines: first, hiddenRules: [] },
        { id: "undefined-b", lines: second, hiddenRules: [] },
      ];
      record.generationStatus = "unsupported";

      const metrics = (buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics;
      expect(metrics.semantic_requirement_extraction).toMatchObject({
        definitive_expected_gold_requirements: 2,
        missing_gold_requirements: 2,
      });
      expect(metrics.base_item_resolution).toMatchObject({
        definitive_positive_gold_requirements: 1,
        missed_or_unresolved_positive_requirements: 1,
        undefined_base_item_gold_requirements_unscored: 1,
        recall: 0,
      });
    }
  });

  it("rejects cross-variant consensus bridged through a generic first identity", () => {
    for (const [id, variants] of [
      [958, [
        { id: "generic", lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1] }] },
        { id: "red", lines: [{ semanticKey: "rose", color: "red", acceptableBaseItemIds: [1] }] },
        { id: "white", lines: [{ semanticKey: "rose", color: "white", acceptableBaseItemIds: [1] }] },
      ]],
      [959, [
        { id: "white", lines: [{ semanticKey: "rose", color: "white", acceptableBaseItemIds: [1] }] },
        { id: "generic", lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1] }] },
        { id: "red", lines: [{ semanticKey: "rose", color: "red", acceptableBaseItemIds: [1] }] },
      ]],
    ] as Array<[number, Array<{ id: string; lines: SemanticRecipeLine[] }>]>) {
      const record = exactSemanticRecord(id);
      record.annotation!.finalRecipe!.acceptableVariants =
        variants.map((variant) => ({ ...variant, hiddenRules: [] }));
      record.generationStatus = "failed";

      const metrics = (buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics;
      expect(metrics.semantic_requirement_extraction).toMatchObject({
        definitive_expected_gold_requirements: 0,
        missing_gold_requirements: 0,
        extraction_recall: { evaluated: 0, correct: 0, accuracy: null },
      });
      expect(metrics.base_item_resolution).toMatchObject({
        scored_products: 0,
        definitive_positive_gold_requirements: 0,
        missed_or_unresolved_positive_requirements: 0,
      });
    }
  });

  it("retains three-variant consensus when explicit enrichment is compatible", () => {
    const record = exactSemanticRecord(960);
    record.annotation!.finalRecipe!.acceptableVariants = [
      {
        id: "generic",
        lines: [{ semanticKey: "rose", acceptableBaseItemIds: [1] }],
        hiddenRules: [],
      },
      {
        id: "red-a",
        lines: [{ semanticKey: "rose", color: "red", acceptableBaseItemIds: [2] }],
        hiddenRules: [],
      },
      {
        id: "red-b",
        lines: [{ semanticKey: "rose", color: "red", acceptableBaseItemIds: [3] }],
        hiddenRules: [],
      },
    ];
    record.generationStatus = "failed";

    const metrics = (buildRecipeBenchmarkMetrics([record]) as any).canonical_metrics;
    expect(metrics.semantic_requirement_extraction).toMatchObject({
      definitive_expected_gold_requirements: 1,
      missing_gold_requirements: 1,
      extraction_recall: { evaluated: 1, correct: 0, accuracy: 0 },
    });
    expect(metrics.base_item_resolution).toMatchObject({
      scored_products: 1,
      definitive_positive_gold_requirements: 1,
      missed_or_unresolved_positive_requirements: 1,
      recall: 0,
    });
  });

  it("uses the global positive-gold Base Item contract for format groups", () => {
    const record = exactSemanticRecord(942);
    record.suggestion = semanticSuggestion([
      { requirementId: "actual-rose", semanticKey: "rose", candidates: [1], selected: 1, quantity: 20 },
      { requirementId: "extra", semanticKey: "vase", candidates: [2], selected: 2 },
    ]);
    const metrics = buildRecipeBenchmarkMetrics([record]) as any;
    expect(metrics.canonical_metrics.base_item_resolution).toMatchObject({
      precision: 0.5,
      recall: 1,
      f1: 0.6667,
    });
    expect(metrics.canonical_format_groups[0]).toMatchObject({
      scored_product_count: 1,
      base_item_precision: 0.5,
      base_item_recall: 1,
      base_item_f1: 0.6667,
    });

    const expectedNoMatch = exactSemanticRecord(943);
    expectedNoMatch.annotation!.finalRecipe!.acceptableVariants[0].lines = [{
      semanticKey: "unknown", acceptableBaseItemIds: [], expectedResolutionOutcome: "no_match",
    }];
    expectedNoMatch.suggestion = semanticSuggestion([
      { requirementId: "unknown", semanticKey: "unknown", candidates: [], selected: 1 },
    ]);
    expectedNoMatch.suggestion.requirements[0].resolution = "no_match";
    expectedNoMatch.suggestion.lines = [];
    const noMatchMetrics = buildRecipeBenchmarkMetrics([expectedNoMatch]) as any;
    expect(noMatchMetrics.canonical_metrics.base_item_resolution).toMatchObject({
      scored_products: 0,
      correctly_resolved_allowed_base_item_matches: 0,
      expected_no_match_outcomes_excluded: 1,
    });
    expect(noMatchMetrics.canonical_format_groups[0]).toMatchObject({
      scored_product_count: 0,
      base_item_f1: null,
    });
  });

  it("derives concise target-leakage safety from the actual generation audit", () => {
    const safe = buildRecipeBenchmarkMetrics([exactSemanticRecord(935)]) as any;
    expect(safe.benchmark_leakage_safety).toMatchObject({
      target_recipe_withheld: true,
      target_correction_history_withheld: true,
      target_product_absent_from_supporting_products: true,
      target_leakage_violation_count: 0,
      target_leakage_violation_reasons: [],
    });

    const unsafe = exactSemanticRecord(936);
    unsafe.generationSafety = {
      targetRecipeInputPresent: true,
      targetCorrectionHistoryInputPresent: true,
      supportingProductIds: [936],
    };
    unsafe.suggestion.leaveOneOut.supportingProductIds = [936];
    const result = (buildRecipeBenchmarkMetrics([unsafe]) as any).benchmark_leakage_safety;
    expect(result).toMatchObject({
      target_recipe_withheld: false,
      target_correction_history_withheld: false,
      target_product_absent_from_supporting_products: false,
      target_leakage_violation_count: 4,
      target_leakage_violation_reasons: [
        { product_id: 936, reason: "target_recipe_present_in_generation_input" },
        { product_id: 936, reason: "target_correction_history_present_in_generation_input" },
        { product_id: 936, reason: "target_product_present_in_supporting_products" },
        { product_id: 936, reason: "target_product_present_in_matcher_supporting_products" },
      ],
    });
  });

  it("marks equally scoring acceptable variants ambiguous instead of using variant IDs", () => {
    const record = benchmarkRecord(product());
    record.suggestion = semanticSuggestion([
      { requirementId: "rose", semanticKey: "red rose", candidates: [1], selected: 1, quantity: 20 },
    ]);
    record.annotation!.acceptableVariants = [
      { id: "a", lines: [{ phrase: "red rose", quantity: 20, acceptableBaseItemIds: [1] }] },
      { id: "z", lines: [{ phrase: "red rose", quantity: 20, acceptableBaseItemIds: [1] }] },
    ];
    record.annotation!.hiddenRules = [];

    const metrics = buildRecipeBenchmarkMetrics([record]) as any;

    expect(metrics.canonical_metrics.full_recipe_exact_match).toEqual({
      evaluated: 0,
      correct: 0,
      accuracy: null,
    });
    expect(metrics.canonical_metrics.per_product[0]).toMatchObject({
      selected_variant_id: null,
      alignment_ambiguous: true,
      full_recipe_exact: null,
    });
    expect(metrics.canonical_metrics.unscored_alignment_ambiguity).toEqual({
      count: 1,
      products: [{
        product_id: record.product.id,
        reason: "semantic_alignment_remained_ambiguous_after_all_scoring_relevant_evidence",
      }],
    });
    expect(metrics.canonical_metrics.resolution_accuracy.evaluated).toBe(0);
    expect(metrics.canonical_metrics.quantity_accuracy.evaluated).toBe(0);
    expect(metrics.canonical_metrics.provenance_integrity.evaluated).toBe(0);
    expect(metrics.canonical_metrics.base_item_resolution).toMatchObject({
      scored_products: 0,
      unscored_products: 1,
      precision: null,
      recall: null,
      f1: null,
    });
    expect(metrics.canonical_format_groups[0]).toMatchObject({
      scored_product_count: 0,
      unscored_alignment_ambiguity: 1,
      base_item_f1: null,
      quantity_accuracy: { evaluated: 0, correct: 0, accuracy: null },
      full_recipe_exact_match: { evaluated: 0, correct: 0, accuracy: null },
    });
    expect(buildRecipeRegressionGate(metrics, {
      canonical_format_groups: [{
        format: "Flower Box",
        category: "Flowers",
        scored_product_count: 1,
        base_item_f1: 1,
        quantity_accuracy: { evaluated: 1, correct: 1, accuracy: 1 },
        full_recipe_exact_match: { evaluated: 1, correct: 1, accuracy: 1 },
      }],
    })).toMatchObject({ status: "pass", flagged_formats: [] });

    record.annotation!.status = "draft";
    const provisional = buildRecipeBenchmarkMetrics([record]) as any;
    expect(provisional.provisional_metrics.full_recipe_exact_match).toEqual({
      evaluated: 0,
      correct: 0,
      accuracy: null,
    });
    expect(provisional.provisional_metrics.unscored_alignment_ambiguity.count).toBe(1);
  });
});