import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type {
  RecipeBenchmarkComparisonResponse,
  RecipeBenchmarkResponse,
} from "@/hooks/use-recipe-benchmarks";
import { ComparisonView } from "../ComparisonView";

function makeRun(
  id: number,
  {
    f1 = 0.9,
    reviewRate = 0.2,
    fingerprint = "same-input",
    productIds = [101],
    gateStatus = "pass" as "pass" | "flagged" | "incomparable",
  } = {},
): RecipeBenchmarkResponse {
  return {
    run: {
      id,
      status: "completed",
      engine_version: `engine-${id}`,
      created_at: "2026-09-05T10:00:00.000Z",
      completed_at: "2026-09-05T10:01:00.000Z",
      exclusions: [],
      sample_definition: { selected_product_ids: productIds },
      metrics: {
        canonical_metrics: { base_item_resolution: { f1 } },
        estimated_manual_review_burden: {
          canonical: {
            review_rate: reviewRate,
            average_edits_per_product: reviewRate,
            products_requiring_review: reviewRate > 0 ? 1 : 0,
            product_denominator: 1,
          },
        },
        confidence_calibration: {
          bands: { high: { evaluated: 1, correct: f1 === 1 ? 1 : 0, accuracy: f1 } },
        },
        canonical_format_groups: [{
          format: "Bouquet",
          category: "Roses",
          scored_product_count: 1,
          base_item_f1: f1,
          quantity_accuracy: { evaluated: 1, correct: 1, accuracy: 1 },
          full_recipe_exact_match: { evaluated: 1, correct: f1 === 1 ? 1 : 0, accuracy: f1 },
        }],
      },
    },
    results: [{
      product_id: 101,
      product_snapshot: { name: "Rose bouquet", category: "Roses", canonical_format: "Bouquet" },
      evidence_used: { benchmark_case_input_fingerprint: fingerprint },
      comparison: {
        baseItem: { f1 },
        missingItems: f1 < 1 ? [{ baseItemName: "Red Rose", quantity: 2 }] : [],
        incorrectExtras: [],
      },
      created_at: "2026-09-05T10:01:00.000Z",
    }],
  };
}

function makeComparison(
  baseline: RecipeBenchmarkResponse,
  candidate: RecipeBenchmarkResponse,
  {
    comparable = true,
    reasons = [] as string[],
    canonicalFailures = [{
      product_id: 101,
      product_snapshot: { name: "Rose bouquet", category: "Roses", canonical_format: "Bouquet" },
      product_name: "Rose bouquet",
      category: "Roses",
      canonical_format: "Bouquet",
      stages: [{
        stage: "base_item_resolution_failure",
        affected_requirements: [{ expected_requirement_id: "red-rose", actual_requirement_id: "pink-rose" }],
      }],
    }],
  } = {},
): RecipeBenchmarkComparisonResponse {
  const gateStatus = !comparable
    ? "incomparable" as const
    : candidate.run.metrics?.canonical_metrics?.base_item_resolution?.f1 === 0.8
      ? "flagged" as const
      : "pass" as const;
  return {
    baseline,
    candidate,
    comparability: {
      comparable,
      reasons,
      changed_canonical_definition_fields: [],
      missing_canonical_definition_fields: [],
      production_configuration_match: true,
      baseline_configuration_fingerprint: "config",
      candidate_configuration_fingerprint: "config",
      input_drift_product_ids: [],
      missing_baseline_result_product_ids: [],
      missing_candidate_result_product_ids: [],
      missing_baseline_snapshot_product_ids: [],
      missing_candidate_snapshot_product_ids: [],
      missing_baseline_fingerprint_product_ids: [],
      missing_candidate_fingerprint_product_ids: [],
      baseline_only_evaluated_product_ids: [],
      candidate_only_evaluated_product_ids: [],
      missing_baseline_format_groups: [],
      missing_candidate_format_groups: [],
      changed_format_groups: [],
      persisted_baseline_linkage_used: false,
      persisted_regression_gate_agrees: null,
    },
    regression_gate: {
      status: gateStatus,
      baseline_run_id: baseline.run.id,
      flagged_formats: gateStatus === "flagged" ? [{
        format: "Bouquet",
        category: "Roses",
        baseline: { base_item_f1: 0.9 },
        current: { base_item_f1: 0.8 },
        reasons: ["base_item_f1_worse"],
      }] : [],
    },
    canonical_failures: canonicalFailures,
  };
}

describe("ComparisonView", () => {
  test("renders canonical accuracy and review burden deltas for comparable runs", () => {
    render(<ComparisonView comparison={makeComparison(
      makeRun(1, { f1: 0.8, reviewRate: 0.4 }),
      makeRun(2, { f1: 0.9, reviewRate: 0.2 }),
    )} />);

    expect(screen.getByTestId("status-regression-gate-pass")).toBeInTheDocument();
    expect(screen.getByTestId("text-accuracy-delta")).toHaveTextContent("+10.0 pp");
    expect(screen.getByTestId("text-burden-delta")).toHaveTextContent("-20.0 pp");
    expect(screen.getByText("Rose bouquet")).toBeInTheDocument();
  });

  test("highlights persisted per-format regression reasons", () => {
    render(<ComparisonView comparison={makeComparison(
      makeRun(1, { f1: 0.9 }),
      makeRun(2, { f1: 0.8, gateStatus: "flagged" }),
    )} />);

    expect(screen.getByTestId("status-regression-gate-flagged")).toHaveTextContent("Flagged");
    expect(screen.getByTestId("list-persisted-flags")).toHaveTextContent("Base Item F1 decreased");
  });

  test("explains cohort and immutable-input drift and suppresses deltas", () => {
    render(<ComparisonView comparison={makeComparison(
      makeRun(1, { productIds: [101], fingerprint: "before" }),
      makeRun(2, { productIds: [101, 102], fingerprint: "after", gateStatus: "incomparable" }),
      {
        comparable: false,
        reasons: [
          "The selected canonical Product cohorts differ.",
          "Production input fingerprints differ for Product IDs: 101.",
        ],
      },
    )} />);

    expect(screen.getByTestId("status-regression-gate-incomparable")).toHaveTextContent("Incomparable");
    expect(screen.getByTestId("status-incomparable-reasons")).toHaveTextContent("Product cohorts differ");
    expect(screen.getByTestId("status-incomparable-reasons")).toHaveTextContent("Production input fingerprints differ");
    expect(screen.getByTestId("text-accuracy-delta")).toHaveTextContent("Suppressed");
  });

  test.each([
    {
      reason: "The production configuration fingerprints differ.",
      configure: (comparison: RecipeBenchmarkComparisonResponse) => {
        comparison.comparability.production_configuration_match = false;
        comparison.comparability.candidate_configuration_fingerprint = "candidate-config";
      },
    },
    {
      reason: "The candidate run is missing required canonical benchmark definition fields: metric_schema_version.",
      configure: (comparison: RecipeBenchmarkComparisonResponse) => {
        comparison.comparability.missing_canonical_definition_fields = ["candidate.metric_schema_version"];
      },
    },
    {
      reason: "Candidate results are missing for Product IDs: 101.",
      configure: (comparison: RecipeBenchmarkComparisonResponse) => {
        comparison.comparability.missing_candidate_result_product_ids = [101];
      },
    },
    {
      reason: "Baseline production input fingerprints are missing for Product IDs: 101.",
      configure: (comparison: RecipeBenchmarkComparisonResponse) => {
        comparison.comparability.missing_baseline_fingerprint_product_ids = [101];
      },
    },
  ])("renders backend evidence without reconstructing comparison truth: $reason", ({ reason, configure }) => {
    const comparison = makeComparison(
      makeRun(1, { f1: 0.9 }),
      makeRun(2, { f1: 0.8 }),
      { comparable: false, reasons: [reason] },
    );
    configure(comparison);

    render(<ComparisonView comparison={comparison} />);

    expect(screen.getByTestId("status-incomparable-reasons")).toHaveTextContent(reason);
    expect(screen.getByTestId("status-regression-gate-incomparable")).toBeInTheDocument();
    expect(screen.getByTestId("text-accuracy-delta")).toHaveTextContent("Suppressed");
  });

  test("shows baseline-only and candidate-only exclusion details", () => {
    const baseline = makeRun(1);
    baseline.run.exclusions = [
      { product_id: 101, reason: "NO_COMPLETED_RECIPE", rationale: "Baseline detail" },
    ];
    const candidate = makeRun(2);
    candidate.run.exclusions = [
      { product_id: 102, reason: "NOT_FOUND_OR_ARCHIVED", rationale: "Candidate detail" },
    ];

    render(<ComparisonView comparison={makeComparison(baseline, candidate)} />);

    expect(screen.getAllByText("Baseline detail")).toHaveLength(2);
    expect(screen.getAllByText("Candidate detail")).toHaveLength(2);
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
  });

  test("renders persisted canonical semantic failures with reviewer-friendly Product names", () => {
    render(<ComparisonView comparison={makeComparison(makeRun(1), makeRun(2))} />);

    expect(screen.getByTestId("card-failure-101")).toHaveTextContent("Rose bouquet");
    expect(screen.getByTestId("card-failure-101")).toHaveTextContent("base item resolution failure");
    expect(screen.getByTestId("card-failure-101")).toHaveTextContent("Canonical semantic gold");
  });

  test("does not promote historical Recipe disagreement to a canonical failure", () => {
    const candidate = makeRun(2, { f1: 0.4 });
    candidate.results[0].comparison = {
      baseItem: { f1: 0 },
      missingItems: [{ baseItemName: "Historical mismatch", quantity: 1 }],
      incorrectExtras: [],
    };

    render(<ComparisonView comparison={makeComparison(makeRun(1), candidate, { canonicalFailures: [] })} />);

    expect(screen.queryByTestId("card-failure-101")).not.toBeInTheDocument();
    expect(screen.queryByText("Historical mismatch")).not.toBeInTheDocument();
    expect(screen.getByText(/No persisted canonical semantic failures/)).toBeInTheDocument();
  });

  test("does not promote provisional-only taxonomy to a canonical failure", () => {
    const candidate = makeRun(2);
    candidate.run.metrics = {
      ...candidate.run.metrics,
      failure_stage_taxonomy: {
        provisional: {
          affected_requirements: {
            extraction_failure: [{
              product_id: 102,
              expected_requirement_id: "draft-only",
            }],
          },
        },
      },
    } as typeof candidate.run.metrics;

    render(<ComparisonView comparison={makeComparison(
      makeRun(1),
      candidate,
      { canonicalFailures: [] },
    )} />);

    expect(screen.queryByText("draft-only")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-failure-102")).not.toBeInTheDocument();
    expect(screen.getByText(/No persisted canonical semantic failures/)).toBeInTheDocument();
  });

  test("does not let run-detail baseline linkage override backend pair incomparability", () => {
    const candidate = makeRun(2, { f1: 0.8 });
    candidate.run.sample_definition = {
      ...candidate.run.sample_definition,
      baseline_linkage: {
        baseline_run_id: 1,
        regression_gate: { status: "pass", flagged_formats: [] },
      },
    };
    const comparison = makeComparison(makeRun(1, { f1: 0.9 }), candidate, {
      comparable: false,
      reasons: ["Candidate results are missing for Product IDs: 101."],
    });
    comparison.regression_gate.flagged_formats = [{
      format: "Bouquet",
      category: "Roses",
      baseline: { base_item_f1: 0.9 },
      current: { base_item_f1: 0.8 },
      reasons: ["base_item_f1_worse"],
    }];

    render(<ComparisonView comparison={comparison} />);

    expect(screen.getByTestId("status-regression-gate-incomparable")).toBeInTheDocument();
    expect(screen.getByTestId("text-accuracy-delta")).toHaveTextContent("Suppressed");
    expect(screen.queryByTestId("list-persisted-flags")).not.toBeInTheDocument();
  });

  test("surfaces authoritative changed format-group coverage", () => {
    const comparison = makeComparison(makeRun(1), makeRun(2), {
      comparable: false,
      reasons: ["Canonical format-group coverage changed: Bouquet / Roses."],
    });
    comparison.comparability.changed_format_groups = ["Bouquet / Roses"];

    render(<ComparisonView comparison={comparison} />);

    expect(screen.getByTestId("status-format-group-drift")).toHaveTextContent(
      "Changed format coverage: Bouquet / Roses",
    );
    expect(screen.getByTestId("text-accuracy-delta")).toHaveTextContent("Suppressed");
  });
});