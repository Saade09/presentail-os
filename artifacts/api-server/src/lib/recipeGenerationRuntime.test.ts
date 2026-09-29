import { describe, expect, it } from "vitest";
import { assembleProductionRecipeMatcher, generateRecipeSuggestion } from "./recipeSuggestionEngine";
import {
  assembleRecipeGenerationRuntime,
  type RecipeGenerationWorkspaceRows,
} from "./recipeGenerationRuntime";

const rows: RecipeGenerationWorkspaceRows = {
  products: [
    {
      id: 1,
      name: "20 Red Roses Bouquet",
      description: null,
      description_ar: null,
      tags: [],
      category: "Flower Boxes",
      is_archived: false,
    },
    {
      id: 2,
      name: "10 Red Roses Bouquet",
      description: null,
      description_ar: null,
      tags: [],
      category: "Flowers",
      is_archived: false,
    },
    {
      id: 3,
      name: "Archived support",
      description: null,
      description_ar: null,
      tags: [],
      category: "Flowers",
      is_archived: true,
    },
  ],
  recipes: [
    {
      product_id: 1,
      base_item_id: 10,
      base_item_name: "Red Rose 60cm",
      base_item_code: "RED-60",
      quantity: "20",
      base_item_status: "active",
      base_item_archived_at: null,
    },
    {
      product_id: 2,
      base_item_id: 10,
      base_item_name: "Red Rose 60cm",
      base_item_code: "RED-60",
      quantity: "10",
      base_item_status: "active",
      base_item_archived_at: null,
    },
    {
      product_id: 2,
      base_item_id: 11,
      base_item_name: "Inactive Rose",
      base_item_code: "INACTIVE",
      quantity: "1",
      base_item_status: "inactive",
      base_item_archived_at: null,
    },
  ],
  baseItems: [
    {
      id: 10,
      name: "Red Rose 60cm",
      code: "RED-60",
      canonical_unit: "stem",
      package_name: "Bunch",
      package_quantity: "20",
      approved_metadata: { color: "red", stemLength: 60 },
      candidate_metadata: [{ color: "blue" }],
      approved_aliases: ["Long Red Rose"],
      status: "active",
      archived_at: null,
    },
    {
      id: 11,
      name: "Inactive Rose",
      code: "INACTIVE",
      canonical_unit: "stem",
      package_name: null,
      package_quantity: null,
      approved_metadata: {},
      approved_aliases: [],
      status: "inactive",
      archived_at: null,
    },
  ],
  rules: [
    {
      id: 1,
      rule_key: "red-rose-hand-bouquet-60cm",
      definition: {
        resolver_base_item_id: 10,
        canonical_formats: ["Hand Bouquet"],
        ingredient_family: "rose",
        color: "red",
        stem_length_cm: 60,
      },
      status: "approved",
      source: "manual",
    },
    {
      id: 2,
      rule_key: "flower-box-sponge",
      definition: {},
      status: "approved",
      source: "deterministic",
    },
    {
      id: 3,
      rule_key: "balloon-metal-ring",
      definition: {},
      status: "approved",
      source: "deterministic",
    },
  ],
};

describe("shared Recipe generation runtime", () => {
  it("assembles identical governed inputs and decisions for live and benchmark consumers", () => {
    const live = assembleRecipeGenerationRuntime(structuredClone(rows));
    const benchmark = assembleRecipeGenerationRuntime(structuredClone(rows));
    const liveCase = live.runForTarget(1)!;
    const benchmarkCase = benchmark.runForTarget(1)!;

    expect(benchmark.configuration).toEqual(live.configuration);
    expect(benchmark.baseItems).toEqual(live.baseItems);
    expect(benchmark.eligibleSupportingProducts).toEqual(live.eligibleSupportingProducts);
    expect(benchmarkCase.supportingProducts).toEqual(liveCase.supportingProducts);
    expect(benchmarkCase.matcherRun).toEqual(liveCase.matcherRun);
    expect(benchmarkCase.matcherRun.configurationFingerprint)
      .toBe(liveCase.matcherRun.configurationFingerprint);
    expect(benchmarkCase.matcherRun.caseInputFingerprint)
      .toBe(liveCase.matcherRun.caseInputFingerprint);
    expect(benchmark.parityLimitations).toEqual([
      expect.stringContaining("Product-format metadata has no persisted field"),
    ]);
  });

  it("fails parity when a route-level filter changes the approved support universe", () => {
    const live = assembleRecipeGenerationRuntime(structuredClone(rows)).runForTarget(1)!;
    const routeFilteredRows = structuredClone(rows);
    routeFilteredRows.recipes = routeFilteredRows.recipes.filter(({ product_id }) => product_id !== 2);
    const filtered = assembleRecipeGenerationRuntime(routeFilteredRows).runForTarget(1)!;

    expect(filtered.supportingProducts).not.toEqual(live.supportingProducts);
    expect(filtered.matcherRun.caseInputFingerprint).not.toBe(live.matcherRun.caseInputFingerprint);
    expect(filtered.matcherRun.suggestion.leaveOneOut.supportingProductIds)
      .not.toEqual(live.matcherRun.suggestion.leaveOneOut.supportingProductIds);
  });

  it("admits only strictly approved deterministic or manual rules into matching and fingerprints", () => {
    const approved = assembleRecipeGenerationRuntime(structuredClone(rows));
    expect(approved.configuration.operationalRules).toEqual({
      flowerBoxSponge: true,
      balloonMetalRing: true,
    });
    expect(approved.configuration.contextualRules).toEqual([
      expect.objectContaining({ ruleKey: "red-rose-hand-bouquet-60cm", resolverBaseItemId: 10 }),
    ]);

    const withoutRules = structuredClone(rows);
    withoutRules.rules = [];
    const excludedVariants = [
      { id: 20, rule_key: "flower-box-sponge", definition: {}, status: "candidate", source: "deterministic" },
      { id: 21, rule_key: "balloon-metal-ring", definition: {}, status: "inactive", source: "manual" },
      { id: 22, rule_key: "red-rose-hand-bouquet-60cm", definition: rows.rules[0].definition, status: "rejected", source: "manual" },
      { id: 23, rule_key: "flower-box-sponge", definition: {}, status: null, source: "deterministic" },
      { id: 24, rule_key: "balloon-metal-ring", definition: {}, status: "approved", source: null },
      { id: 25, rule_key: "red-rose-hand-bouquet-60cm", definition: rows.rules[0].definition, status: "deprecated", source: "manual" },
      { id: 26, rule_key: "flower-box-sponge", definition: {}, status: "approved", source: "learned" },
    ];
    const baseline = assembleRecipeGenerationRuntime(withoutRules);
    const withExcludedRules = assembleRecipeGenerationRuntime({
      ...withoutRules,
      rules: excludedVariants,
    });

    expect(withExcludedRules.ruleRows).toEqual([]);
    expect(withExcludedRules.configuration.operationalRules).toEqual({
      flowerBoxSponge: false,
      balloonMetalRing: false,
    });
    expect(withExcludedRules.configuration.contextualRules).toEqual([]);
    expect(withExcludedRules.runForTarget(1)!.matcherRun.suggestion)
      .toEqual(baseline.runForTarget(1)!.matcherRun.suggestion);
    expect(withExcludedRules.runForTarget(1)!.matcherRun.configurationFingerprint)
      .toBe(baseline.runForTarget(1)!.matcherRun.configurationFingerprint);
    expect(withExcludedRules.parityLimitations[0]).toContain("Approved deterministic rules are missing");
  });

  it.each([
    { label: "package only", aliases: [], approvedMetadata: {} },
    { label: "package plus approved alias", aliases: ["Long Red Rose"], approvedMetadata: {} },
    { label: "package plus approved metadata", aliases: [], approvedMetadata: { color: "red" } },
  ])("preserves governed package facts for $label", ({ aliases, approvedMetadata }) => {
    const packageRows = structuredClone(rows);
    packageRows.baseItems[0].approved_aliases = aliases;
    packageRows.baseItems[0].approved_metadata = approvedMetadata;
    packageRows.recipes[0].quantity = "7";
    const runtime = assembleRecipeGenerationRuntime(packageRows);
    const item = assembleProductionRecipeMatcher(runtime.configuration).baseItems[0];

    expect(item.quantity).toBe(1);
    expect(item.metadata).toMatchObject({
      governedPackageFacts: true,
      packageName: "Bunch",
      packageSize: 20,
    });
    expect(runtime.runForTarget(1)!.approvedRecipe[0].quantity).toBe(7);

    const suggestion = generateRecipeSuggestion(
      {
        id: 99,
        name: "Pack of 20 Red Roses",
        description: null,
        descriptionAr: null,
        category: "Flowers",
        tags: [],
      },
      [],
      [item],
    );
    expect(suggestion.requirements[0]).toMatchObject({
      quantity: 1,
      attributes: { packageSize: 20 },
    });
    expect(suggestion.lines).toEqual([
      expect.objectContaining({ baseItemId: 10, quantity: 1 }),
    ]);
    expect(suggestion.requirements[0].candidateCompatibility?.[0]?.comparisons.packageSize)
      .toMatchObject({
        state: "compatible",
        sources: [expect.objectContaining({ source: "governed_package", value: 20 })],
      });
  });

  it("keeps unapproved metadata diagnostic-only and fingerprint-neutral", () => {
    const withCandidate = assembleRecipeGenerationRuntime(structuredClone(rows));
    const withoutCandidateRows = structuredClone(rows);
    withoutCandidateRows.baseItems[0].candidate_metadata = [];
    const withoutCandidate = assembleRecipeGenerationRuntime(withoutCandidateRows);
    const configuration = assembleProductionRecipeMatcher(withCandidate.configuration);

    expect(JSON.stringify(configuration)).not.toContain("blue");
    expect(withCandidate.runForTarget(1)!.matcherRun.configurationFingerprint)
      .toBe(withoutCandidate.runForTarget(1)!.matcherRun.configurationFingerprint);
  });
});