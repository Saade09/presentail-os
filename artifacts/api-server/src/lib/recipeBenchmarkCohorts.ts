export const RECIPE_HISTORICAL_COHORT_21 = [
  2, 6, 18, 30, 78, 169, 193, 241, 242, 250, 317, 322, 332, 337, 344, 345, 395, 412, 449, 575, 649,
] as const;

export type RecipeBenchmarkSelectionTag =
  | "eligibility:active_product"
  | "eligibility:completed_recipe"
  | "format:hand_bouquet"
  | "format:unknown"
  | "language:english_only"
  | "gold:source_recipe_consistent"
  | "gold:source_recipe_conflict";

export type FrozenRecipeBenchmarkCohort = {
  cohort_id: "historical_21" | "expanded_v1";
  ordered_product_ids: readonly number[];
  freeze_status: "frozen" | "pending";
  selection_basis: string;
  selection_used_matcher_outputs: false;
  provenance: {
    kind: "historical_contract" | "read_only_source_fact_query";
    observed_at: string | null;
    workspace_scope: string;
    database_writes: false;
  };
};

/**
 * The historical sequence is a compatibility contract. Do not sort it or
 * replace missing IDs with currently available Products.
 */
export const HISTORICAL_21_RECIPE_BENCHMARK_COHORT = {
  cohort_id: "historical_21",
  ordered_product_ids: RECIPE_HISTORICAL_COHORT_21,
  freeze_status: "frozen",
  selection_basis: "Existing exact historical benchmark denominator.",
  selection_used_matcher_outputs: false,
  provenance: {
    kind: "historical_contract",
    observed_at: null,
    workspace_scope: "The workspace in which the historical benchmark is run.",
    database_writes: false,
  },
} as const satisfies FrozenRecipeBenchmarkCohort;

/**
 * The first discovery was performed against a sparse development snapshot
 * which does not contain the previously validated historical cohort. It is
 * retained as audit evidence, not promoted into an immutable benchmark cohort.
 */
export const RECIPE_EXPANDED_COHORT_V1: readonly number[] = [];

export const EXPANDED_V1_RECIPE_BENCHMARK_COHORT = {
  cohort_id: "expanded_v1",
  ordered_product_ids: RECIPE_EXPANDED_COHORT_V1,
  freeze_status: "pending",
  selection_basis: "Pending read-only discovery in the intended workspace; the sparse development discovery is not a valid frozen cohort.",
  selection_used_matcher_outputs: false,
  provenance: {
    kind: "read_only_source_fact_query",
    observed_at: "2026-09-03T16:52:11Z",
    workspace_scope: "Sparse development snapshot; not the intended historical benchmark workspace.",
    database_writes: false,
  },
  discovery_counts: {
    active_products_inspected: 122,
    eligible_products: 4,
    active_products_without_completed_recipe: 118,
  },
  discovery_candidates_not_frozen: [2, 3, 4, 49] as const,
  products: [
    {
      product_id: 2,
      observed_name: "Passionate Roses",
      selection_confirmation: "confirmed",
      selection_tags: [
        "eligibility:active_product", "eligibility:completed_recipe", "format:hand_bouquet",
        "language:english_only", "gold:source_recipe_consistent",
      ],
      tag_confirmation: {
        confirmed: ["eligibility:active_product", "eligibility:completed_recipe", "language:english_only"],
        unconfirmed: ["format:hand_bouquet", "gold:source_recipe_consistent"],
      },
    },
    {
      product_id: 3,
      observed_name: "Roses Of Purity",
      selection_confirmation: "confirmed",
      selection_tags: [
        "eligibility:active_product", "eligibility:completed_recipe", "format:hand_bouquet",
        "language:english_only", "gold:source_recipe_consistent",
      ],
      tag_confirmation: {
        confirmed: ["eligibility:active_product", "eligibility:completed_recipe", "language:english_only"],
        unconfirmed: ["format:hand_bouquet", "gold:source_recipe_consistent"],
      },
    },
    {
      product_id: 4,
      observed_name: "Blushed Roses",
      selection_confirmation: "confirmed",
      selection_tags: [
        "eligibility:active_product", "eligibility:completed_recipe", "format:hand_bouquet",
        "language:english_only", "gold:source_recipe_conflict",
      ],
      tag_confirmation: {
        confirmed: [
          "eligibility:active_product", "eligibility:completed_recipe", "language:english_only",
          "gold:source_recipe_conflict",
        ],
        unconfirmed: ["format:hand_bouquet"],
      },
    },
    {
      product_id: 49,
      observed_name: "Evergreen Forest",
      selection_confirmation: "confirmed",
      selection_tags: [
        "eligibility:active_product", "eligibility:completed_recipe", "format:unknown",
        "language:english_only", "gold:source_recipe_conflict",
      ],
      tag_confirmation: {
        confirmed: [
          "eligibility:active_product", "eligibility:completed_recipe", "format:unknown",
          "language:english_only", "gold:source_recipe_conflict",
        ],
        unconfirmed: [],
      },
    },
  ] as const satisfies readonly {
    product_id: number;
    observed_name: string;
    selection_confirmation: "confirmed" | "unconfirmed";
    selection_tags: readonly RecipeBenchmarkSelectionTag[];
    tag_confirmation: {
      confirmed: readonly RecipeBenchmarkSelectionTag[];
      unconfirmed: readonly RecipeBenchmarkSelectionTag[];
    };
  }[],
  sentinels: {
    first_product_id: null,
    last_product_id: null,
    ordered_ids_sha256: null,
    required_product_facts: [
      { product_id: 2, name: "Passionate Roses", required_active_recipe_base_item_ids: [1] },
      { product_id: 3, name: "Roses Of Purity", required_active_recipe_base_item_ids: [3] },
      { product_id: 4, name: "Blushed Roses", required_active_recipe_base_item_ids: [7] },
      { product_id: 49, name: "Evergreen Forest", required_active_recipe_base_item_ids: [9, 13] },
    ],
  },
  coverage: {
    by_format: { Hand_Bouquet: 3, Unknown: 1 },
    by_category: { Uncategorized: 4 },
    by_language: { english_only: 4, includes_arabic: 0 },
    by_source_recipe_review: { consistent: 2, conflict: 2 },
  },
  missing_strata: [
    "Flower Box", "Vase Arrangement", "Flower Basket", "Wooden Letter", "Wooden Heart",
    "Balloon Product", "Bundle", "Single Gift Item", "Arabic or bilingual Product text",
    "Categorized Product",
  ],
  pending_reason: "The runtime DATABASE_URL snapshot exposes only Products 2, 6, 18, 30, and 78 from historical_21; only Product 2 has an eligible Recipe there. Freeze in the intended workspace remains pending.",
} as const;

export const FROZEN_RECIPE_BENCHMARK_COHORTS = {
  historical_21: HISTORICAL_21_RECIPE_BENCHMARK_COHORT,
  expanded_v1: EXPANDED_V1_RECIPE_BENCHMARK_COHORT,
} as const;