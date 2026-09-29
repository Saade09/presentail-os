import { describe, expect, it } from "vitest";
import {
  EXPANDED_V1_RECIPE_BENCHMARK_COHORT,
  RECIPE_EXPANDED_COHORT_V1,
  RECIPE_HISTORICAL_COHORT_21,
} from "./recipeBenchmarkCohorts";
import { RECIPE_BENCHMARK_GOLD_EXPANDED_V1 } from "./recipeBenchmarkGold";

describe("frozen recipe benchmark data", () => {
  it("preserves the exact ordered historical denominator", () => {
    expect(RECIPE_HISTORICAL_COHORT_21).toEqual([
      2, 6, 18, 30, 78, 169, 193, 241, 242, 250, 317, 322, 332, 337, 344, 345, 395, 412, 449, 575, 649,
    ]);
  });

  it("leaves expanded_v1 pending instead of freezing a sparse workspace discovery", () => {
    expect(RECIPE_EXPANDED_COHORT_V1).toEqual([]);
    expect(EXPANDED_V1_RECIPE_BENCHMARK_COHORT.freeze_status).toBe("pending");
    expect(EXPANDED_V1_RECIPE_BENCHMARK_COHORT.discovery_candidates_not_frozen).toEqual([2, 3, 4, 49]);
    expect(EXPANDED_V1_RECIPE_BENCHMARK_COHORT.discovery_counts).toEqual({
      active_products_inspected: 122,
      eligible_products: 4,
      active_products_without_completed_recipe: 118,
    });
    expect(EXPANDED_V1_RECIPE_BENCHMARK_COHORT.selection_used_matcher_outputs).toBe(false);
    expect(EXPANDED_V1_RECIPE_BENCHMARK_COHORT.sentinels.ordered_ids_sha256).toBeNull();
    expect(EXPANDED_V1_RECIPE_BENCHMARK_COHORT.pending_reason).toMatch(/intended workspace/i);
    expect(EXPANDED_V1_RECIPE_BENCHMARK_COHORT.products.every(({ tag_confirmation }) =>
      tag_confirmation.confirmed.length + tag_confirmation.unconfirmed.length > 0)).toBe(true);
    expect(EXPANDED_V1_RECIPE_BENCHMARK_COHORT.missing_strata.length).toBeGreaterThan(0);
  });

  it("keeps every agent-authored label draft and provisional", () => {
    expect(RECIPE_BENCHMARK_GOLD_EXPANDED_V1.map(({ product_id }) => product_id))
      .toEqual(EXPANDED_V1_RECIPE_BENCHMARK_COHORT.discovery_candidates_not_frozen);
    for (const gold of RECIPE_BENCHMARK_GOLD_EXPANDED_V1) {
      expect(gold.author_kind).toBe("agent");
      expect(gold.state).toBe("draft");
      expect(gold.gold_review).toMatchObject({
        state: "draft",
        author_kind: "agent",
        author_identity: null,
        reviewer_identity: null,
        adjudication_state: "pending",
      });
      expect(gold.canonical_fingerprint).toBeNull();
      expect(gold.provisional_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(gold.provenance.authored_from_matcher_output).toBe(false);
      expect(gold.final_recipe_expectation.lines.length).toBeGreaterThan(0);
      expect(gold.final_recipe_expectation.acceptable_variants).toHaveLength(1);
      expect(gold.final_recipe_expectation.acceptable_variants?.[0].lines)
        .toEqual(gold.final_recipe_expectation.lines);
      expect(gold.final_recipe_expectation.lines.every((line) =>
        line.source.field === "name" || line.source.field === "description" || line.source.field === "description_ar"))
        .toBe(true);
      expect(gold.candidate_retrieval_gold.length).toBeGreaterThan(0);
      expect(gold.compatibility_gold.length).toBeGreaterThan(0);
      expect(gold.hidden_rules).toHaveLength(2);
    }
  });

  it("records conflict and catalog-gap sentinels", () => {
    const pink = RECIPE_BENCHMARK_GOLD_EXPANDED_V1.find(({ product_id }) => product_id === 4)!;
    expect(pink.final_recipe_expectation.excluded_observed_recipe_lines).toEqual([
      expect.objectContaining({ base_item_id: 7 }),
    ]);
    const evergreen = RECIPE_BENCHMARK_GOLD_EXPANDED_V1.find(({ product_id }) => product_id === 49)!;
    expect(evergreen.final_recipe_expectation.disposition).toBe("partial_catalog_coverage");
    expect(evergreen.candidate_retrieval_gold.filter(({ catalog_gap }) => catalog_gap)).toHaveLength(5);
    expect(evergreen.final_recipe_expectation.excluded_observed_recipe_lines.map(({ base_item_id }) => base_item_id))
      .toEqual([9, 13]);
  });
});