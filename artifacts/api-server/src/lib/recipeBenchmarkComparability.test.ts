import { describe, expect, it } from "vitest";
import {
  compareRecipeBenchmarkRuns,
  projectCanonicalRecipeFailures,
  type RecipeBenchmarkComparableResult,
  type RecipeBenchmarkComparableRun,
} from "./recipeBenchmarkComparability";
import { deterministicRecipeFingerprint } from "./recipeSuggestionEngine";

const definition = {
  cohort_manifest_fingerprint: "cohort-v1",
  canonical_gold_fingerprint: "gold-v1",
  alignment_schema_version: "alignment-v1",
  metric_schema_version: "metrics-v1",
  scoring_policy_version: "scoring-v1",
};

function run(
  id: number,
  {
    config = "configuration-v1" as string | null,
    benchmarkDefinition = definition as Record<string, unknown> | null,
    selected = [101] as number[] | null,
    evaluated = [101] as number[] | null,
    baselineLinkage,
    f1 = 0.9,
  }: {
    config?: string | null;
    benchmarkDefinition?: Record<string, unknown> | null;
    selected?: number[] | null;
    evaluated?: number[] | null;
    baselineLinkage?: Record<string, unknown>;
    f1?: number;
  } = {},
): RecipeBenchmarkComparableRun {
  return {
    id,
    version_manifest: {
      ...(config == null ? {} : { configuration_fingerprint: config }),
      ...(benchmarkDefinition == null ? {} : { benchmark_definition: benchmarkDefinition }),
    },
    sample_definition: {
      ...(selected == null ? {} : { selected_product_ids: selected }),
      ...(evaluated == null ? {} : { successfully_evaluated_product_ids: evaluated }),
      ...(baselineLinkage ? { baseline_linkage: baselineLinkage } : {}),
    },
    metrics: {
      regression_gate_inputs: {
        canonical_format_groups: [{
          format: "Bouquet",
          category: "Roses",
          product_count: 1,
          scored_product_count: 1,
          base_item_f1: f1,
          quantity_accuracy: { accuracy: 1 },
          full_recipe_exact_match: { accuracy: 1 },
        }],
      },
    },
  };
}

function result(
  productId = 101,
  options: {
    fingerprint?: string | null;
    snapshot?: Record<string, unknown> | null;
  } = {},
): RecipeBenchmarkComparableResult {
  const snapshot = options.snapshot === undefined ? {
    target: { id: productId, name: `Product ${productId}` },
    supportingProducts: [],
    targetExclusion: { excludedProductId: productId, directRecipeWithheld: true },
  } : options.snapshot;
  const fingerprint = options.fingerprint === undefined && snapshot
    ? deterministicRecipeFingerprint(snapshot)
    : options.fingerprint ?? null;
  return {
    product_id: productId,
    product_snapshot: { name: `Product ${productId}`, category: "Roses", canonical_format: "Bouquet" },
    evidence_used: {
      ...(fingerprint == null ? {} : { production_case_input_fingerprint: fingerprint }),
      ...(snapshot == null ? {} : { production_case_input_snapshot: snapshot }),
    },
  };
}

describe("compareRecipeBenchmarkRuns", () => {
  it("allows an arbitrary pair when the complete immutable contract is identical", () => {
    const comparison = compareRecipeBenchmarkRuns(run(1), run(2), [result()], [result()]);

    expect(comparison.comparability).toMatchObject({
      comparable: true,
      reasons: [],
      persisted_baseline_linkage_used: false,
      production_configuration_match: true,
    });
    expect(comparison.regression_gate.status).toBe("pass");
  });

  it("fails closed when production configuration differs", () => {
    const comparison = compareRecipeBenchmarkRuns(
      run(1, { config: "before" }),
      run(2, { config: "after" }),
      [result()],
      [result()],
    );

    expect(comparison.comparability.comparable).toBe(false);
    expect(comparison.comparability.production_configuration_match).toBe(false);
    expect(comparison.comparability.reasons).toContain("The production configuration fingerprints differ.");
  });

  it("fails closed when either production configuration fingerprint is missing", () => {
    for (const [baseline, candidate] of [
      [run(1, { config: null }), run(2)],
      [run(1), run(2, { config: null })],
    ] as const) {
      const comparison = compareRecipeBenchmarkRuns(baseline, candidate, [result()], [result()]);
      expect(comparison.comparability.comparable).toBe(false);
      expect(comparison.comparability.production_configuration_match).toBeNull();
      expect(comparison.comparability.reasons.join(" ")).toMatch(/missing its production configuration fingerprint/i);
    }
  });

  it("fails closed when either benchmark definition is missing", () => {
    for (const [baseline, candidate] of [
      [run(1, { benchmarkDefinition: null }), run(2)],
      [run(1), run(2, { benchmarkDefinition: null })],
    ] as const) {
      const comparison = compareRecipeBenchmarkRuns(baseline, candidate, [result()], [result()]);
      expect(comparison.comparability.comparable).toBe(false);
      expect(comparison.comparability.missing_canonical_definition_fields.length).toBeGreaterThan(0);
    }
  });

  it.each([
    "cohort_manifest_fingerprint",
    "canonical_gold_fingerprint",
    "alignment_schema_version",
    "metric_schema_version",
    "scoring_policy_version",
  ])("fails closed when %s differs", (field) => {
    const comparison = compareRecipeBenchmarkRuns(
      run(1),
      run(2, { benchmarkDefinition: { ...definition, [field]: "changed" } }),
      [result()],
      [result()],
    );

    expect(comparison.comparability.comparable).toBe(false);
    expect(comparison.comparability.changed_canonical_definition_fields).toContain(field);
  });

  it("fails closed when corresponding production case fingerprints differ", () => {
    const baselineSnapshot = {
      target: { id: 101, name: "Before" },
      supportingProducts: [],
      targetExclusion: { excludedProductId: 101, directRecipeWithheld: true },
    };
    const candidateSnapshot = {
      target: { id: 101, name: "After" },
      supportingProducts: [],
      targetExclusion: { excludedProductId: 101, directRecipeWithheld: true },
    };
    const comparison = compareRecipeBenchmarkRuns(
      run(1),
      run(2),
      [result(101, { snapshot: baselineSnapshot })],
      [result(101, { snapshot: candidateSnapshot })],
    );

    expect(comparison.comparability.comparable).toBe(false);
    expect(comparison.comparability.input_drift_product_ids).toEqual([101]);
  });

  it("detects baseline-only missing results and snapshots", () => {
    const missingResult = compareRecipeBenchmarkRuns(run(1), run(2), [], [result()]);
    expect(missingResult.comparability.missing_baseline_result_product_ids).toEqual([101]);
    expect(missingResult.comparability.comparable).toBe(false);

    const missingSnapshot = compareRecipeBenchmarkRuns(
      run(1),
      run(2),
      [result(101, { snapshot: null })],
      [result()],
    );
    expect(missingSnapshot.comparability.missing_baseline_snapshot_product_ids).toEqual([101]);
    expect(missingSnapshot.comparability.comparable).toBe(false);
  });

  it("detects candidate-only missing results and snapshots", () => {
    const missingResult = compareRecipeBenchmarkRuns(run(1), run(2), [result()], []);
    expect(missingResult.comparability.missing_candidate_result_product_ids).toEqual([101]);
    expect(missingResult.comparability.comparable).toBe(false);

    const missingSnapshot = compareRecipeBenchmarkRuns(
      run(1),
      run(2),
      [result()],
      [result(101, { snapshot: null })],
    );
    expect(missingSnapshot.comparability.missing_candidate_snapshot_product_ids).toEqual([101]);
    expect(missingSnapshot.comparability.comparable).toBe(false);
  });

  it("detects missing fingerprints on both sides independently", () => {
    const missingBaseline = compareRecipeBenchmarkRuns(
      run(1),
      run(2),
      [result(101, { fingerprint: null })],
      [result()],
    );
    expect(missingBaseline.comparability.missing_baseline_fingerprint_product_ids).toEqual([101]);

    const missingCandidate = compareRecipeBenchmarkRuns(
      run(1),
      run(2),
      [result()],
      [result(101, { fingerprint: null })],
    );
    expect(missingCandidate.comparability.missing_candidate_fingerprint_product_ids).toEqual([101]);
  });

  it.each([
    ["baseline", {}],
    ["baseline", []],
    ["baseline", { target: { id: 999 }, supportingProducts: [], targetExclusion: { excludedProductId: 999, directRecipeWithheld: true } }],
    ["candidate", {}],
    ["candidate", []],
    ["candidate", { target: { id: 999 }, supportingProducts: [], targetExclusion: { excludedProductId: 999, directRecipeWithheld: true } }],
  ])("fails closed for malformed %s production snapshots", (side, snapshot) => {
    const malformed = result(101, {
      snapshot: snapshot as Record<string, unknown>,
      fingerprint: deterministicRecipeFingerprint(snapshot),
    });
    const comparison = compareRecipeBenchmarkRuns(
      run(1),
      run(2),
      side === "baseline" ? [malformed] : [result()],
      side === "candidate" ? [malformed] : [result()],
    );

    expect(comparison.comparability.comparable).toBe(false);
    expect(side === "baseline"
      ? comparison.comparability.missing_baseline_snapshot_product_ids
      : comparison.comparability.missing_candidate_snapshot_product_ids).toEqual([101]);
  });

  it("detects differing evaluated coverage symmetrically", () => {
    const comparison = compareRecipeBenchmarkRuns(
      run(1, { selected: [101, 102], evaluated: [101, 102] }),
      run(2, { selected: [101], evaluated: [101] }),
      [result(101), result(102)],
      [result(101)],
    );

    expect(comparison.comparability.comparable).toBe(false);
    expect(comparison.comparability.baseline_only_evaluated_product_ids).toEqual([102]);
    expect(comparison.comparability.candidate_only_evaluated_product_ids).toEqual([]);
  });

  it("does not let linkage to another baseline authorize missing evidence", () => {
    const comparison = compareRecipeBenchmarkRuns(
      run(1),
      run(2, {
        config: null,
        baselineLinkage: {
          baseline_run_id: 999,
          regression_gate: {
            status: "pass",
            baseline_run_id: 999,
            flagged_formats: [],
            decision_support_only: true,
          },
        },
      }),
      [result()],
      [result()],
    );

    expect(comparison.comparability.persisted_baseline_linkage_used).toBe(false);
    expect(comparison.comparability.persisted_regression_gate_agrees).toBeNull();
    expect(comparison.comparability.comparable).toBe(false);
  });

  it("uses and verifies the exact persisted baseline pair against the regression contract", () => {
    const comparison = compareRecipeBenchmarkRuns(
      run(1),
      run(2, {
        baselineLinkage: {
          baseline_run_id: 1,
          regression_gate: {
            status: "pass",
            baseline_run_id: 1,
            flagged_formats: [],
            decision_support_only: true,
          },
        },
      }),
      [result()],
      [result()],
    );

    expect(comparison.comparability).toMatchObject({
      comparable: true,
      persisted_baseline_linkage_used: true,
      persisted_regression_gate_agrees: true,
    });
    expect(comparison.regression_gate.status).toBe("pass");
  });

  it("rejects an embedded persisted gate that references a different baseline", () => {
    const comparison = compareRecipeBenchmarkRuns(
      run(1),
      run(2, {
        baselineLinkage: {
          baseline_run_id: 1,
          regression_gate: {
            status: "pass",
            baseline_run_id: 999,
            flagged_formats: [],
            decision_support_only: true,
          },
        },
      }),
      [result()],
      [result()],
    );

    expect(comparison.comparability.persisted_baseline_linkage_used).toBe(true);
    expect(comparison.comparability.persisted_regression_gate_agrees).toBe(false);
    expect(comparison.comparability.comparable).toBe(false);
  });

  it.each(["baseline", "candidate"] as const)(
    "fails closed when canonical format coverage is missing from the %s",
    (side) => {
      const baseline = run(1);
      const candidate = run(2);
      const missing = side === "baseline" ? baseline : candidate;
      missing.metrics = { regression_gate_inputs: { canonical_format_groups: [] } };
      const comparison = compareRecipeBenchmarkRuns(baseline, candidate, [result()], [result()]);

      expect(comparison.comparability.comparable).toBe(false);
      expect(side === "baseline"
        ? comparison.comparability.missing_baseline_format_groups
        : comparison.comparability.missing_candidate_format_groups).toEqual(["Bouquet / Roses"]);
      expect(comparison.regression_gate).toMatchObject({ status: "incomparable", flagged_formats: [] });
    },
  );

  it.each([0, 2])(
    "keeps runs comparable when only scored Product coverage changes from 1 to %i",
    (scoredProductCount) => {
      const candidate = run(2);
      const candidateGroups = (candidate.metrics.regression_gate_inputs as {
        canonical_format_groups: Array<Record<string, unknown>>;
      }).canonical_format_groups;
      candidateGroups[0].scored_product_count = scoredProductCount;

      const comparison = compareRecipeBenchmarkRuns(run(1), candidate, [result()], [result()]);

      expect(comparison.comparability.changed_format_groups).toEqual([]);
      expect(comparison.comparability.comparable).toBe(true);
    },
  );

  it("fails closed when immutable canonical format Product coverage changes", () => {
    const candidate = run(2);
    const candidateGroups = (candidate.metrics.regression_gate_inputs as {
      canonical_format_groups: Array<Record<string, unknown>>;
    }).canonical_format_groups;
    candidateGroups[0].product_count = 2;

    const comparison = compareRecipeBenchmarkRuns(run(1), candidate, [result()], [result()]);

    expect(comparison.comparability.changed_format_groups).toEqual(["Bouquet / Roses"]);
    expect(comparison.comparability.comparable).toBe(false);
    expect(comparison.regression_gate).toMatchObject({ status: "incomparable", flagged_formats: [] });
  });

  it("keeps F1-only movement comparable and lets the regression gate flag it", () => {
    const metricMovement = compareRecipeBenchmarkRuns(
      run(1, { f1: 0.9 }),
      run(2, { f1: 0.8 }),
      [result()],
      [result()],
    );
    expect(metricMovement.comparability.changed_format_groups).toEqual([]);
    expect(metricMovement.comparability.comparable).toBe(true);
    expect(metricMovement.regression_gate.status).toBe("flagged");
  });
});

describe("projectCanonicalRecipeFailures", () => {
  it("projects canonical taxonomy only and joins persisted Product snapshots", () => {
    const failures = projectCanonicalRecipeFailures({
      failure_stage_taxonomy: {
        canonical: {
          affected_requirements: {
            base_item_resolution_failure: [{
              product_id: 101,
              expected_requirement_id: "red-rose",
              actual_requirement_id: "pink-rose",
              stage: "base_item_resolution_failure",
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
      canonical_metrics: {
        per_product: [
          { product_id: 101, alignment_ambiguous: false, full_recipe_exact: false },
        ],
      },
    }, [
      { product_id: 101, product_snapshot: { name: "Canonical failure", category: "Roses", canonical_format: "Bouquet" } },
      { product_id: 102, product_snapshot: { name: "Draft-only failure" } },
    ]);

    expect(failures).toEqual([expect.objectContaining({
      product_id: 101,
      product_name: "Canonical failure",
      category: "Roses",
      canonical_format: "Bouquet",
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: "base_item_resolution_failure" }),
      ]),
    })]);
    expect(failures[0].stages).toContainEqual(expect.objectContaining({
      stage: "final_recipe_exactness_failure",
    }));
    expect(failures.map(({ product_id }) => product_id)).not.toContain(102);
  });
});