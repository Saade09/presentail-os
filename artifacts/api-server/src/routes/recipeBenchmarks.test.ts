import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockClient = {
  query: (...args: unknown[]) => mockDbQuery(...args),
  release: () => mockClientRelease(),
};
let workspaceRole: "owner" | "member" = "owner";
let allowedPages: string[] | null = null;
let workspaceOwnerId = "workspace_a";

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: async () => mockClient,
  },
}));
vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = workspaceOwnerId;
    wreq.workspaceRole = workspaceRole;
    wreq.workspaceActualRole = workspaceRole;
    wreq.allowedPages = allowedPages;
    wreq.userId = "benchmark_user";
    wreq.userEmail = "benchmark@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, page: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(page),
}));
import recipeBenchmarksRouter, {
  benchmarkAnnotationFromGold,
  independentGoldQuality,
  RECIPE_HISTORICAL_COHORT_21,
} from "./recipeBenchmarks";
import {
  RECIPE_BENCHMARK_GOLD_EXPANDED_V1,
  recipeBenchmarkGoldLine,
  type RecipeBenchmarkGoldCase,
} from "../lib/recipeBenchmarkGold";
import { alignRecipeSemantics } from "../lib/recipeBenchmarkMetrics";
import {
  deterministicRecipeFingerprint,
  generateRecipeSuggestion,
} from "../lib/recipeSuggestionEngine";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(recipeBenchmarksRouter);
  return instance;
}

const products = [
  { id: 1, name: "Medium Round Flower Box with 20 Red Roses", description: null, category: "Flowers", tags: [] },
  { id: 2, name: "Medium Round Flower Box with White Roses", description: null, category: "Flowers", tags: [] },
];
const recipes = [
  { product_id: 1, base_item_id: 10, base_item_name: "Red Roses", base_item_code: "ROSE-RED", quantity: "20" },
  { product_id: 1, base_item_id: 11, base_item_name: "Medium Round Flower Box", base_item_code: "BOX-M", quantity: "1" },
  { product_id: 1, base_item_id: 12, base_item_name: "Floral Sponge", base_item_code: "SPONGE", quantity: "1" },
  { product_id: 2, base_item_id: 11, base_item_name: "Medium Round Flower Box", base_item_code: "BOX-M", quantity: "1" },
  { product_id: 2, base_item_id: 12, base_item_name: "Floral Sponge", base_item_code: "SPONGE", quantity: "1" },
];
const baseItems = [
  { id: 10, name: "Red Roses", code: "ROSE-RED" },
  { id: 11, name: "Medium Round Flower Box", code: "BOX-M" },
  { id: 12, name: "Floral Sponge", code: "SPONGE" },
];

describe("recipe benchmark routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRole = "owner";
    allowedPages = null;
    workspaceOwnerId = "workspace_a";
  });

  it("locks the independently reviewed historical cohort exactly", () => {
    expect(RECIPE_HISTORICAL_COHORT_21).toEqual([
      2, 6, 18, 30, 78, 169, 193, 241, 242, 250, 317, 322, 332, 337, 344, 345, 395, 412, 449, 575, 649,
    ]);
  });

  it("aligns independently authored multi-botanical gold to real runtime extraction regardless of array order", () => {
    const description = "Contains 4 White Roses, 2 Eustoma, 3 Hypericum, and 1 Trachelium.";
    const ingredients = [
      { key: "white-rose", phrase: "White Roses", quantity: 4 },
      { key: "eustoma", phrase: "Eustoma", quantity: 2 },
      { key: "hypericum", phrase: "Hypericum", quantity: 3 },
      { key: "trachelium", phrase: "Trachelium", quantity: 1 },
    ];
    const lines = ingredients.map(({ key, phrase, quantity }) => recipeBenchmarkGoldLine({
      requirement_key: key,
      kind: "ingredient",
      subtype: "botanical",
      source: {
        field: "description",
        occurrence: 1,
        exact_phrase: phrase,
        normalized_phrase: phrase,
        span: { start: description.indexOf(phrase), end: description.indexOf(phrase) + phrase.length },
      },
      source_phrase: phrase,
      quantity,
      unit: null,
      expected_base_item_id: null,
      expected_base_item_name: phrase,
    }));
    const template = RECIPE_BENCHMARK_GOLD_EXPANDED_V1[0];
    const gold: RecipeBenchmarkGoldCase = {
      ...template,
      product_id: 99_001,
      final_recipe_expectation: {
        disposition: "partial_catalog_coverage",
        lines,
        acceptable_variants: [{
          variant_id: "multi-botanical",
          lines,
          evidence_basis: ["Independent Product-language annotation."],
        }],
        excluded_observed_recipe_lines: [],
      },
      candidate_retrieval_gold: lines.map((line) => ({
        requirement_key: line.requirement_key,
        relevant_base_item_ids: [],
        catalog_gap: true,
      })),
      compatibility_gold: [],
      hidden_rules: [],
    };
    const annotation = benchmarkAnnotationFromGold(gold)!;
    const suggestion = generateRecipeSuggestion({
      id: gold.product_id,
      name: "Mixed Botanical Arrangement",
      description,
      descriptionAr: null,
      category: "Flowers",
      tags: [],
    }, [], []);
    const variant = annotation.finalRecipe!.acceptableVariants[0];
    const semanticPairs = (alignment: ReturnType<typeof alignRecipeSemantics>, expected = variant) =>
      alignment.pairs.map(({ expected_index, actual_index }) => [
        expected.lines![expected_index].phrase,
        suggestion.requirements[actual_index].phrase,
      ]).sort();

    const forward = alignRecipeSemantics(suggestion, variant);
    expect(forward.ambiguous).toBe(false);
    expect(forward.pairs).toHaveLength(4);
    expect(semanticPairs(forward)).toEqual(ingredients.map(({ phrase }) => [phrase, phrase]).sort());
    expect(suggestion.requirements.map(({ evidence }) => evidence.occurrence)).toEqual([1, 1, 1, 1]);
    expect(variant.lines!.map(({ sourceOccurrence }) => sourceOccurrence)).toEqual([1, 1, 1, 1]);

    const reversedSuggestion = {
      ...suggestion,
      requirements: [...suggestion.requirements].reverse(),
    };
    const reversedVariant = { ...variant, lines: [...variant.lines!].reverse() };
    const reversed = alignRecipeSemantics(reversedSuggestion, reversedVariant);
    const reversedPairs = reversed.pairs.map(({ expected_index, actual_index }) => [
      reversedVariant.lines[expected_index].phrase,
      reversedSuggestion.requirements[actual_index].phrase,
    ]).sort();
    expect(reversed.ambiguous).toBe(false);
    expect(reversedPairs).toEqual(semanticPairs(forward));
  });

  it("preserves general gold requirement kinds, sources, units, and semantic Helium through the adapter", () => {
    const template = RECIPE_BENCHMARK_GOLD_EXPANDED_V1[0];
    const lines = [
      recipeBenchmarkGoldLine({
        requirement_key: "rose", kind: "ingredient", subtype: "botanical",
        source: { field: "description", occurrence: 1, exact_phrase: "Red Rose", normalized_phrase: "Red Rose" },
        source_phrase: "Red Rose",
        semantic_attributes: { color: "red" },
        quantity: 1, unit: null, expected_base_item_id: 1, expected_base_item_name: "Red Rose",
      }),
      recipeBenchmarkGoldLine({
        requirement_key: "vase", kind: "container", subtype: "container",
        source: { field: "name", occurrence: 1, exact_phrase: "Glass Vase", normalized_phrase: "Glass Vase" },
        source_phrase: "Glass Vase", quantity: 1, unit: null, expected_base_item_id: 2, expected_base_item_name: "Glass Vase",
      }),
      recipeBenchmarkGoldLine({
        requirement_key: "balloon", kind: "component", subtype: "balloon",
        source: { field: "description", occurrence: 1, exact_phrase: "Balloons", normalized_phrase: "Balloons" },
        source_phrase: "Balloons", quantity: 2, unit: null, expected_base_item_id: 3, expected_base_item_name: "Balloon",
      }),
      recipeBenchmarkGoldLine({
        requirement_key: "helium", kind: "component", subtype: "helium_fill",
        source: { field: "description", occurrence: 1, exact_phrase: "Helium", normalized_phrase: "Helium" },
        source_phrase: "Helium", quantity: 2, unit: null, expected_base_item_id: 4, expected_base_item_name: "Helium",
      }),
    ];
    const gold: RecipeBenchmarkGoldCase = {
      ...template,
      product_id: 99_002,
      final_recipe_expectation: {
        disposition: "complete",
        lines,
        acceptable_variants: [{
          variant_id: "mixed-kinds",
          lines,
          evidence_basis: ["Independent semantic fixture."],
          hidden_rules: [],
        }, {
          variant_id: "mixed-kinds-with-explicit-absence",
          lines,
          evidence_basis: ["Independent semantic fixture."],
          hidden_rules: [{ rule_key: "balloon_metal_ring", expected: false, reason: "Not applicable." }],
        }],
        excluded_observed_recipe_lines: [],
      },
      candidate_retrieval_gold: lines.map((line) => ({
        requirement_key: line.requirement_key,
        relevant_base_item_ids: [line.expected_base_item_id!],
        catalog_gap: false,
      })),
      compatibility_gold: [],
      hidden_rules: [{ rule_key: "balloon_metal_ring", expected: false, reason: "Not applicable." }],
    };

    const annotation = benchmarkAnnotationFromGold(gold)!;
    expect(annotation.finalRecipe!.acceptableVariants[0].lines).toMatchObject([
      {
        kind: "ingredient", subtype: "botanical", sourceField: "description", sourceOccurrence: 1, unit: null,
        color: "red",
      },
      { kind: "container", subtype: "container", sourceField: "name", sourceOccurrence: 1, unit: null },
      { kind: "component", subtype: "balloon", sourceField: "description", sourceOccurrence: 1, unit: null },
      { kind: "component", subtype: "helium_fill", sourceField: "description", sourceOccurrence: 1, unit: null },
    ]);
    expect(annotation.finalRecipe!.acceptableVariants[0].hiddenRules).toEqual([]);
    expect(annotation.finalRecipe!.acceptableVariants[1].hiddenRules).toEqual([
      { ruleKey: "balloon_metal_ring", expected: false, acceptableBaseItemIds: undefined },
    ]);
    expect(annotation.hiddenRules).not.toContainEqual(expect.objectContaining({ ruleKey: "helium" }));
    expect(recipeBenchmarkGoldLine({ ...lines[2], unit: "piece" }).unit).toBe("piece");

    const suggestion = generateRecipeSuggestion({
      id: gold.product_id,
      name: "Glass Vase",
      description: "Includes 1 Red Rose and 2 helium-filled Balloons.",
      descriptionAr: null,
      category: "Flowers",
      tags: [],
    }, [], []);
    const alignment = alignRecipeSemantics(suggestion, annotation.finalRecipe!.acceptableVariants[0]);
    expect(alignment).toMatchObject({
      ambiguous: false,
      quantity: { evaluated: 4, correct: 4, accuracy: 1 },
    });
    expect(alignment.pairs).toHaveLength(4);
  });

  it("keeps the approved historical gold-quality classifications independent of matcher agreement", () => {
    const reviewed = (name: string, recipeNames: string[], baseItemNames: string[] = []) =>
      independentGoldQuality({
        id: 1,
        name,
        description: null,
        category: "Flowers",
        tags: [],
        recipes: recipeNames.map((baseItemName, index) => ({
          baseItemId: index + 1,
          baseItemName,
          quantity: baseItemName === "Wrapping Paper" ? 60 : 30,
        })),
      }, baseItemNames.map((baseItemName, index) => ({
        baseItemId: index + 100,
        baseItemName,
        quantity: 1,
      })), { flowerBoxSponge: true, balloonMetalRing: true }).classification;

    expect(reviewed("Great Dad Balloon", ["Foil Balloon"])).toBe("questionable/legacy/incomplete");
    expect(reviewed("Sunflower Bloom Basket", ["Sunflowers"])).toBe("questionable/legacy/incomplete");
    expect(reviewed("Bundle of 30 Pink Roses", ["Pink Roses", "Wrapping Paper"]))
      .toBe("requires human confirmation");
    expect(reviewed("Summer Fever Box with Red Dried Limonium", ["Red Limonium"], ["Red Dried Limonium"]))
      .toBe("questionable/legacy/incomplete");
  });

  it("executes the exact historical cohort through the dedicated preset", async () => {
    const cohortProducts = RECIPE_HISTORICAL_COHORT_21.map((id) => ({
      id,
      name: id === 337 ? "100 Rose Majesty Bouquet" : `Historical Product ${id}`,
      description: id === 337 ? "Bouquet includes:\n• 100 Red Roses" : null,
      description_ar: null,
      category: id === 337 ? "Flower Boxes" : "Flowers",
      tags: [],
    }));
    const cohortRecipes = RECIPE_HISTORICAL_COHORT_21.map((id) => ({
      product_id: id,
      base_item_id: 10,
      base_item_name: "Red Rose 60cm",
      base_item_code: "ROSE-RED-60",
      quantity: "1",
    }));
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM products p")) return { rows: cohortProducts, rowCount: cohortProducts.length };
      if (sql.includes("FROM product_recipes")) return { rows: cohortRecipes, rowCount: cohortRecipes.length };
      if (sql.includes("FROM base_items bi")) {
        return {
          rows: [{ id: 10, name: "Red Rose 60cm", code: "ROSE-RED-60", approved_metadata: {}, approved_aliases: [] }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO recipe_benchmark_runs")) return { rows: [{ id: 81 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const response = await request(app())
      .post("/products/recipe-benchmarks")
      .send({ cohort: "historical_21" });

    expect(response.status).toBe(201);
    expect(response.body.sample_definition).toMatchObject({
      selected_product_ids: [...RECIPE_HISTORICAL_COHORT_21],
    });
    expect(response.body.historical_cohort).toMatchObject({
      exact_requested_cohort: true,
      required_product_ids: [...RECIPE_HISTORICAL_COHORT_21],
      full_denominator: 21,
      historical_clean_recipe_denominator: expect.any(Number),
    });
    expect(response.body.results.map(({ product_id }: { product_id: number }) => product_id))
      .toEqual([...RECIPE_HISTORICAL_COHORT_21]);
    expect(response.body.metrics.products_evaluated).toBe(21);
    expect(response.body.sample_definition.historical_clean_recipe_reporting).toEqual(expect.objectContaining({
      full_denominator: 21,
      historical_clean_recipe_denominator: expect.any(Number),
      excluded: expect.any(Array),
      rationale: expect.any(String),
      limitations: expect.any(String),
    }));
  });

  it("fails closed while expanded_v1 discovery is pending in the intended workspace", async () => {
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM products p")) return {
        rows: [{
          id: 2,
          name: "Medium Round Flower Box with White Roses",
          description: "This arrangement includes: 20 white roses.",
          description_ar: null,
          category: "Flowers",
          tags: [],
        }],
        rowCount: 1,
      };
      if (sql.includes("FROM product_recipes")) return {
        rows: [{ product_id: 2, base_item_id: 3, base_item_name: "White Rose", base_item_code: "WR", quantity: "20" }],
        rowCount: 1,
      };
      if (sql.includes("FROM base_items bi")) return {
        rows: [{ id: 3, name: "White Rose", code: "WR", approved_metadata: {}, approved_aliases: [] }],
        rowCount: 1,
      };
      return { rows: [], rowCount: 0 };
    });

    const response = await request(app())
      .post("/products/recipe-benchmarks")
      .send({ cohort: "expanded_v1" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "BENCHMARK_COHORT_FREEZE_PENDING",
      cohort: "expanded_v1",
      required_product_ids: [],
      sparse_snapshot_candidates_not_frozen: [2, 3, 4, 49],
      reason: expect.stringMatching(/intended workspace/i),
    });
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockDbQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO recipe_benchmark_runs")))
      .toBe(false);
  });

  it("rejects members who cannot manage products before reading recipe data", async () => {
    workspaceRole = "member";
    allowedPages = ["products"];

    const response = await request(app()).post("/products/recipe-benchmarks").send({ sample_size: 1 });

    expect(response.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("runs leave-one-out generation and writes only immutable benchmark tables", async () => {
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM products p")) return { rows: products, rowCount: products.length };
      if (sql.includes("FROM product_recipes")) return { rows: recipes, rowCount: recipes.length };
      if (sql.includes("FROM base_items bi")) return { rows: baseItems, rowCount: baseItems.length };
      if (sql.includes("INSERT INTO recipe_benchmark_runs")) return { rows: [{ id: 77 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const response = await request(app())
      .post("/products/recipe-benchmarks")
      .send({ product_ids: [1] });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      run_id: 77,
      status: "completed",
      sample_definition: expect.objectContaining({
        direct_recipe_withheld: true,
        selected_product_ids: [1],
      }),
    });
    expect(response.body.results[0].evidence_used.leave_one_out).toMatchObject({
      excludedProductId: 1,
      supportingProductIds: [2],
    });
    expect(response.body.sample_definition).toMatchObject({
      immutable_version_manifest: {
        configuration_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      bounded_ai: {
        executed: false,
        limitation: expect.stringContaining("does not establish AI-output parity"),
      },
      deterministic_parity_limitations: expect.arrayContaining([
        expect.stringContaining("remained read-only"),
      ]),
    });
    expect(response.body.results[0].evidence_used).toMatchObject({
      configuration_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      case_input_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      bounded_ai: { executed: false },
    });

    const queries = mockDbQuery.mock.calls.map(([sql]) => String(sql));
    const protectedTables = [
      "recipe_rules",
      "product_recipes",
      "base_items",
      "base_item_aliases",
      "base_item_metadata_candidates",
      "inventory",
      "recipe_corrections",
    ];
    for (const table of protectedTables) {
      expect(queries.some((sql) =>
        new RegExp(`\\b(?:UPDATE|DELETE\\s+FROM|INSERT\\s+INTO)\\s+${table}\\b`, "i").test(sql)),
      `benchmark mutated ${table}`).toBe(false);
    }
    expect(queries.filter((sql) => /recipe_benchmark_(?:runs|results)/.test(sql))).toHaveLength(2);
    expect(queries).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(queries).toContain("COMMIT");
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
    for (const [, params] of mockDbQuery.mock.calls.filter(([, params]) => Array.isArray(params)).slice(0, 3)) {
      expect(params).toContain("workspace_a");
    }
  });

  it("reruns the exact persisted baseline cohort and reports a decision-only regression gate", async () => {
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM recipe_benchmark_runs") && !sql.includes("INSERT INTO")) {
        return {
          rows: [{
            id: 50,
            engine_version: "baseline-v1",
            sample_definition: { selected_product_ids: [1] },
            metrics: {
              canonical_format_groups: [{
                format: "Flower Box",
                category: "Flowers",
                base_item_f1: 1,
                quantity_accuracy: { accuracy: 1 },
                full_recipe_exact_match: { accuracy: 1 },
              }],
            },
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM recipe_benchmark_results") && !sql.includes("INSERT INTO")) {
        return {
          rows: [{
            product_id: 1,
            approved_recipe: [
              { baseItemId: 10, baseItemName: "Red Roses", baseItemCode: "ROSE-RED", quantity: 20 },
              { baseItemId: 11, baseItemName: "Medium Round Flower Box", baseItemCode: "BOX-M", quantity: 1 },
              { baseItemId: 12, baseItemName: "Floral Sponge", baseItemCode: "SPONGE", quantity: 1 },
            ],
            evidence_used: {
              exact_generation_inputs: {
                target_product_language_fields: {
                  id: 1,
                  name: products[0].name,
                  description: null,
                  category: "Flowers",
                  tags: [],
                },
                candidate_universe: {
                  supporting_products: [{
                    id: 2,
                    name: products[1].name,
                    description: null,
                    category: "Flowers",
                    tags: [],
                    recipe: [
                      { baseItemId: 12, baseItemName: "Floral Sponge", baseItemCode: "SPONGE", quantity: 1 },
                      { baseItemId: 11, baseItemName: "Medium Round Flower Box", baseItemCode: "BOX-M", quantity: 1 },
                    ],
                  }],
                },
              },
            },
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM products p")) return { rows: products, rowCount: products.length };
      if (sql.includes("FROM product_recipes")) return { rows: recipes, rowCount: recipes.length };
      if (sql.includes("FROM base_items bi")) return { rows: baseItems, rowCount: baseItems.length };
      if (sql.includes("INSERT INTO recipe_benchmark_runs")) return { rows: [{ id: 82 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const response = await request(app())
      .post("/products/recipe-benchmarks")
      .send({ baseline_run_id: 50 });

    expect(response.status).toBe(201);
    expect(response.body.sample_definition).toMatchObject({
      selected_product_ids: [1],
      baseline_linkage: {
        baseline_run_id: 50,
        baseline_engine_version: "baseline-v1",
        same_frozen_cohort: true,
        immutable_inputs_match: false,
        regression_gate: {
          baseline_run_id: 50,
          decision_support_only: true,
        },
      },
    });
    expect(response.body).toMatchObject({
      regression_gate: {
        baseline_run_id: 50,
        decision_support_only: true,
        status: "incomparable",
      },
      metrics: {
        confidence_calibration: expect.any(Object),
        manual_review_burden: expect.any(Object),
        canonical_format_groups: expect.any(Array),
        full_recipe_exact_match: expect.any(Object),
        benchmark_leakage_safety: {
          target_recipe_withheld: true,
          target_correction_history_withheld: true,
          target_product_absent_from_supporting_products: true,
          target_leakage_violation_count: 0,
        },
      },
    });
  });

  it("requires the persisted production configuration fingerprint for baseline comparability", async () => {
    let baselineRun: Record<string, unknown> | null = null;
    let baselineEvidence: Record<string, unknown> | null = null;
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM recipe_benchmark_runs") && !sql.includes("INSERT INTO")) {
        return { rows: baselineRun ? [baselineRun] : [], rowCount: baselineRun ? 1 : 0 };
      }
      if (sql.includes("FROM recipe_benchmark_results") && !sql.includes("INSERT INTO")) {
        return {
          rows: baselineEvidence ? [{
            product_id: 1,
            approved_recipe: recipes.filter(({ product_id }) => product_id === 1),
            evidence_used: baselineEvidence,
          }] : [],
          rowCount: baselineEvidence ? 1 : 0,
        };
      }
      if (sql.includes("FROM products p")) return { rows: products, rowCount: products.length };
      if (sql.includes("FROM product_recipes")) return { rows: recipes, rowCount: recipes.length };
      if (sql.includes("FROM base_items bi")) return { rows: baseItems, rowCount: baseItems.length };
      if (sql.includes("INSERT INTO recipe_benchmark_runs")) return { rows: [{ id: 83 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const seed = await request(app())
      .post("/products/recipe-benchmarks")
      .send({ product_ids: [1] });
    expect(seed.status).toBe(201);
    const currentFingerprint =
      seed.body.sample_definition.immutable_version_manifest.configuration_fingerprint;
    const benchmarkDefinition =
      seed.body.sample_definition.immutable_version_manifest.benchmark_definition;
    const seedResultInsert = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO recipe_benchmark_results"));
    const persistedSeedEvidence = JSON.parse(String(seedResultInsert?.[1]?.[6]));
    baselineEvidence = {
      production_case_input_fingerprint:
        seed.body.results[0].evidence_used.production_case_input_fingerprint,
      production_case_input_snapshot:
        persistedSeedEvidence.production_case_input_snapshot,
    };
    baselineRun = {
      id: 60,
      engine_version: seed.body.engine_version,
      sample_definition: {
        selected_product_ids: [1],
        successfully_evaluated_product_ids: [1],
      },
      metrics: seed.body.metrics,
      version_manifest: {
        configuration_fingerprint: currentFingerprint,
        benchmark_definition: benchmarkDefinition,
      },
    };

    const same = await request(app())
      .post("/products/recipe-benchmarks")
      .send({ baseline_run_id: 60 });
    expect(same.status).toBe(201);
    expect(same.body.sample_definition.baseline_linkage).toMatchObject({
      production_configuration_match: true,
      baseline_configuration_fingerprint: currentFingerprint,
      current_configuration_fingerprint: currentFingerprint,
      regression_gate: { status: "pass" },
    });

    baselineRun.version_manifest = { benchmark_definition: benchmarkDefinition };
    const legacy = await request(app())
      .post("/products/recipe-benchmarks")
      .send({ baseline_run_id: 60 });
    expect(legacy.status).toBe(201);
    expect(legacy.body.sample_definition.baseline_linkage).toMatchObject({
      production_configuration_match: false,
      baseline_configuration_fingerprint: null,
      regression_gate: {
        status: "incomparable",
        reason: "Persisted baseline lacks the required production configuration fingerprint.",
      },
    });

    const differentFingerprint = "0".repeat(64);
    baselineRun.version_manifest = {
      configuration_fingerprint: differentFingerprint,
      benchmark_definition: benchmarkDefinition,
    };
    const changed = await request(app())
      .post("/products/recipe-benchmarks")
      .send({ baseline_run_id: 60 });
    expect(changed.status).toBe(201);
    expect(changed.body.sample_definition.baseline_linkage).toMatchObject({
      production_configuration_match: false,
      baseline_configuration_fingerprint: differentFingerprint,
      current_configuration_fingerprint: currentFingerprint,
      regression_gate: {
        status: "incomparable",
        changed_production_configuration_fields: ["configuration_fingerprint"],
        reason: "Production configuration fingerprint differs from the persisted baseline.",
      },
    });
  });

  it("persists a frozen pre-change baseline manifest and its immutable audit inputs", async () => {
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM products p")) return { rows: products, rowCount: products.length };
      if (sql.includes("FROM product_recipes")) return { rows: recipes, rowCount: recipes.length };
      if (sql.includes("FROM base_items bi")) return { rows: baseItems, rowCount: baseItems.length };
      if (sql.includes("INSERT INTO recipe_benchmark_runs")) return { rows: [{ id: 79 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const response = await request(app())
      .post("/products/recipe-benchmarks")
      .send({ product_ids: [1], baseline_mode: "frozen_pre_change" });

    expect(response.status).toBe(201);
    expect(response.body.engine_version).toBe("benchmark-deterministic-v2-requirement-aware");
    expect(response.body.sample_definition).toMatchObject({
      benchmark_mode: "frozen_pre_change_baseline",
      immutable_version_manifest: {
        engine: "benchmark-deterministic-v2-requirement-aware",
        aliases: "governed-base-item-aliases-v1",
        metadata: "governed-base-item-metadata-v1",
        prompt: "bounded-candidate-ranking-v2",
        model: null,
      },
    });
    const resultInsert = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO recipe_benchmark_results"),
    );
    const evidence = JSON.parse(String(resultInsert?.[1]?.[6]));
    expect(evidence).toMatchObject({
      immutable_version_manifest: {
        benchmark_mode: "frozen_pre_change_baseline",
        engine: "benchmark-deterministic-v2-requirement-aware",
      },
      exact_generation_inputs: {
        target_product_language_fields: { id: 1, name: products[0].name },
        target_recipe_withheld_from_generation: true,
        candidate_universe: {
          base_items: expect.any(Array),
          supporting_products: expect.any(Array),
        },
        comparison_inputs: {
          approved_recipe: expect.any(Array),
          generated_lines: expect.any(Array),
        },
      },
      failure_stage_classification: expect.any(Object),
      representative_outcome_flags: expect.any(Object),
    });
  });

  it("rejects duplicate explicit product ids before opening a benchmark transaction", async () => {
    const response = await request(app())
      .post("/products/recipe-benchmarks")
      .send({ product_ids: [1, 1] });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/duplicates/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("reads a report only within the current workspace", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 7, status: "completed", metrics: { products_evaluated: 1 } }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ product_id: 1, comparison: { baseItem: { f1: 1 } } }],
        rowCount: 1,
      });

    const response = await request(app()).get("/products/recipe-benchmarks/7");

    expect(response.status).toBe(200);
    expect(response.body.run.id).toBe(7);
    expect(response.body.results).toHaveLength(1);
    expect(mockDbQuery.mock.calls[0][1]).toEqual([7, "workspace_a"]);
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("status = 'completed'");
    expect(mockDbQuery.mock.calls[1][1]).toEqual([7, "workspace_a"]);
  });

  it("does not return unfinished reports through a direct detail URL", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await request(app()).get("/products/recipe-benchmarks/8");

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/completed/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("status = 'completed'");
  });

  it("returns an authoritative read-only comparison for two completed workspace runs", async () => {
    const benchmarkDefinition = {
      cohort_manifest_fingerprint: "cohort-v1",
      canonical_gold_fingerprint: "gold-v1",
      alignment_schema_version: "alignment-v1",
      metric_schema_version: "metrics-v1",
      scoring_policy_version: "scoring-v1",
    };
    const metrics = {
      regression_gate_inputs: {
        canonical_format_groups: [{
          format: "Bouquet",
          category: "Roses",
          scored_product_count: 1,
          base_item_f1: 1,
          quantity_accuracy: { accuracy: 1 },
          full_recipe_exact_match: { accuracy: 1 },
        }],
      },
    };
    const productionCaseSnapshot = {
      target: { id: 101, name: "Rose bouquet" },
      supportingProducts: [],
      targetExclusion: { excludedProductId: 101, directRecipeWithheld: true },
    };
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [1, 2].map((id) => ({
          id,
          status: "completed",
          version_manifest: {
            configuration_fingerprint: "config-v1",
            benchmark_definition: benchmarkDefinition,
          },
          sample_definition: {
            selected_product_ids: [101],
            successfully_evaluated_product_ids: [101],
          },
          metrics: id === 2 ? {
            ...metrics,
            failure_stage_taxonomy: {
              canonical: {
                affected_requirements: {
                  extraction_failure: [{
                    product_id: 101,
                    expected_requirement_id: "red-rose",
                    actual_requirement_id: null,
                    stage: "extraction_failure",
                  }],
                },
              },
              provisional: {
                affected_requirements: {
                  extraction_failure: [{
                    product_id: 102,
                    expected_requirement_id: "draft-only",
                    stage: "extraction_failure",
                  }],
                },
              },
            },
          } : metrics,
        })),
        rowCount: 2,
      })
      .mockResolvedValueOnce({
        rows: [1, 2].map((run_id) => ({
          run_id,
          product_id: 101,
          product_snapshot: { name: "Rose bouquet", category: "Roses", canonical_format: "Bouquet" },
          evidence_used: {
            production_case_input_fingerprint: deterministicRecipeFingerprint(productionCaseSnapshot),
            production_case_input_snapshot: productionCaseSnapshot,
          },
          comparison: run_id === 2 ? {
            missingItems: [{ baseItemName: "Historical disagreement" }],
          } : {},
        })),
        rowCount: 2,
      });

    const response = await request(app())
      .get("/products/recipe-benchmarks/compare?baseline_run_id=1&candidate_run_id=2");

    expect(response.status).toBe(200);
    expect(response.body.comparability).toMatchObject({
      comparable: true,
      production_configuration_match: true,
      persisted_baseline_linkage_used: false,
    });
    expect(response.body.regression_gate.status).toBe("pass");
    expect(response.body.canonical_failures).toEqual([expect.objectContaining({
      product_id: 101,
      product_name: "Rose bouquet",
      stages: [expect.objectContaining({ stage: "extraction_failure" })],
    })]);
    expect(JSON.stringify(response.body.canonical_failures)).not.toContain("draft-only");
    expect(JSON.stringify(response.body.canonical_failures)).not.toContain("Historical disagreement");
    expect(mockDbQuery.mock.calls[0][1]).toEqual([[1, 2], "workspace_a"]);
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("status = 'completed'");
    expect(mockDbQuery.mock.calls[1][1]).toEqual([[1, 2], "workspace_a"]);
  });

  it("fails closed when either selected comparison run is not completed in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, status: "completed" }],
      rowCount: 1,
    });

    const response = await request(app())
      .get("/products/recipe-benchmarks/compare?baseline_run_id=1&candidate_run_id=2");

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/completed/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("workspace_owner_id = $2");
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("status = 'completed'");
  });

  it("lists only completed reports in the current workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 9, status: "completed", completed_at: "2026-09-05T12:00:00.000Z" },
        { id: 7, status: "completed", completed_at: "2026-09-04T12:00:00.000Z" },
      ],
      rowCount: 2,
    });

    const response = await request(app()).get("/products/recipe-benchmarks");

    expect(response.status).toBe(200);
    expect(response.body.runs.map((run: { id: number }) => run.id)).toEqual([9, 7]);
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["workspace_a"]);
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("status = 'completed'");
  });

  it("rolls back rather than persisting a partial completed run", async () => {
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM products p")) return { rows: products, rowCount: products.length };
      if (sql.includes("FROM product_recipes")) return { rows: recipes, rowCount: recipes.length };
      if (sql.includes("FROM base_items bi")) return { rows: baseItems, rowCount: baseItems.length };
      if (sql.includes("INSERT INTO recipe_benchmark_runs")) return { rows: [{ id: 78 }], rowCount: 1 };
      if (sql.includes("INSERT INTO recipe_benchmark_results")) throw new Error("simulated insert failure");
      return { rows: [], rowCount: 1 };
    });

    const response = await request(app()).post("/products/recipe-benchmarks").send({ product_ids: [1] });

    expect(response.status).toBe(500);
    expect(mockDbQuery.mock.calls.map(([sql]) => String(sql))).toContain("ROLLBACK");
    expect(mockDbQuery.mock.calls.map(([sql]) => String(sql))).not.toContain("COMMIT");
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });
});