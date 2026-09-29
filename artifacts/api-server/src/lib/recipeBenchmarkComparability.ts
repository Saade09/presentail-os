import { buildRecipeRegressionGate, type RegressionGateResult } from "./recipeBenchmarkMetrics";
import { deterministicRecipeFingerprint } from "./recipeSuggestionEngine";

type JsonRecord = Record<string, unknown>;
export type RecipeBenchmarkComparableRun = {
  id: number;
  version_manifest: unknown;
  sample_definition: unknown;
  metrics: Record<string, unknown>;
};
export type RecipeBenchmarkComparableResult = {
  product_id: number;
  evidence_used: unknown;
  product_snapshot?: unknown;
};

const canonicalFields = [
  "cohort_manifest_fingerprint",
  "canonical_gold_fingerprint",
  "alignment_schema_version",
  "metric_schema_version",
  "scoring_policy_version",
] as const;

const record = (value: unknown): JsonRecord =>
  value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const ids = (value: unknown): number[] | null =>
  Array.isArray(value) && value.every((id) => Number.isInteger(id) && id > 0) ? value as number[] : null;
const groups = (metrics: JsonRecord): Map<string, JsonRecord> => {
  const input = record(metrics.regression_gate_inputs);
  const values = input.canonical_format_groups ?? metrics.canonical_format_groups;
  return new Map((Array.isArray(values) ? values : []).map((item) => {
    const group = record(item);
    return [`${String(group.format)} / ${String(group.category)}`, group];
  }));
};

export type RecipeBenchmarkComparability = {
  comparable: boolean;
  reasons: string[];
  changed_canonical_definition_fields: string[];
  missing_canonical_definition_fields: string[];
  production_configuration_match: boolean | null;
  baseline_configuration_fingerprint: string | null;
  candidate_configuration_fingerprint: string | null;
  input_drift_product_ids: number[];
  missing_baseline_result_product_ids: number[];
  missing_candidate_result_product_ids: number[];
  missing_baseline_snapshot_product_ids: number[];
  missing_candidate_snapshot_product_ids: number[];
  missing_baseline_fingerprint_product_ids: number[];
  missing_candidate_fingerprint_product_ids: number[];
  baseline_only_evaluated_product_ids: number[];
  candidate_only_evaluated_product_ids: number[];
  missing_baseline_format_groups: string[];
  missing_candidate_format_groups: string[];
  changed_format_groups: string[];
  persisted_baseline_linkage_used: boolean;
  persisted_regression_gate_agrees: boolean | null;
};

export type CanonicalRecipeFailure = {
  product_id: number;
  product_snapshot: JsonRecord | null;
  product_name: string | null;
  category: string | null;
  canonical_format: string | null;
  stages: Array<{
    stage: string;
    affected_requirements: JsonRecord[];
  }>;
};

function sameIds(left: number[], right: number[], ordered = false): boolean {
  const normalize = (values: number[]) => ordered ? values : [...values].sort((a, b) => a - b);
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function gateSignature(value: unknown) {
  const gate = record(value);
  const flags = Array.isArray(gate.flagged_formats) ? gate.flagged_formats : [];
  return {
    status: gate.status,
    baseline_run_id: gate.baseline_run_id,
    flagged_formats: flags.map((value) => {
      const flag = record(value);
      return {
        format: flag.format,
        category: flag.category,
        reasons: Array.isArray(flag.reasons) ? [...flag.reasons].map(String).sort() : [],
      };
    }).sort((left, right) =>
      `${String(left.format)}/${String(left.category)}`.localeCompare(`${String(right.format)}/${String(right.category)}`)),
  };
}

function validProductionSnapshot(
  value: unknown,
  productId: number,
  fingerprint: string | null,
): boolean {
  if (!fingerprint || value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = record(value);
  const target = record(snapshot.target);
  const exclusion = record(snapshot.targetExclusion);
  if (
    Number(target.id) !== productId
    || !Array.isArray(snapshot.supportingProducts)
    || Number(exclusion.excludedProductId) !== productId
    || exclusion.directRecipeWithheld !== true
  ) {
    return false;
  }
  return deterministicRecipeFingerprint(snapshot) === fingerprint;
}

export function projectCanonicalRecipeFailures(
  metrics: Record<string, unknown>,
  results: Array<{ product_id: number; product_snapshot?: unknown }>,
): CanonicalRecipeFailure[] {
  const canonical = record(record(metrics.failure_stage_taxonomy).canonical);
  const affectedByStage = record(canonical.affected_requirements);
  const snapshots = new Map(results.map((result) => [result.product_id, record(result.product_snapshot)]));
  const grouped = new Map<number, Map<string, JsonRecord[]>>();

  for (const [stage, values] of Object.entries(affectedByStage)) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const failure = record(value);
      const productId = Number(failure.product_id);
      if (!Number.isInteger(productId) || productId < 1) continue;
      const stages = grouped.get(productId) ?? new Map<string, JsonRecord[]>();
      stages.set(stage, [...(stages.get(stage) ?? []), failure]);
      grouped.set(productId, stages);
    }
  }
  const canonicalMetrics = record(metrics.canonical_metrics ?? metrics.canonical);
  const canonicalProducts = Array.isArray(canonicalMetrics.per_product)
    ? canonicalMetrics.per_product
    : [];
  for (const value of canonicalProducts) {
    const product = record(value);
    const productId = Number(product.product_id);
    if (!Number.isInteger(productId) || productId < 1) continue;
    const stages = grouped.get(productId) ?? new Map<string, JsonRecord[]>();
    if (product.alignment_ambiguous === true) {
      stages.set("semantic_alignment_ambiguity", stages.get("semantic_alignment_ambiguity") ?? []);
    }
    if (product.full_recipe_exact === false) {
      stages.set("final_recipe_exactness_failure", stages.get("final_recipe_exactness_failure") ?? []);
    }
    if (stages.size > 0) grouped.set(productId, stages);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([productId, stages]) => {
      const snapshot = snapshots.get(productId);
      return {
        product_id: productId,
        product_snapshot: snapshot && Object.keys(snapshot).length > 0 ? snapshot : null,
        product_name: typeof snapshot?.name === "string" ? snapshot.name : null,
        category: typeof snapshot?.category === "string" ? snapshot.category : null,
        canonical_format: typeof snapshot?.canonical_format === "string" ? snapshot.canonical_format : null,
        stages: [...stages.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([stage, affected_requirements]) => ({ stage, affected_requirements })),
      };
    });
}

export function compareRecipeBenchmarkRuns(
  baseline: RecipeBenchmarkComparableRun,
  candidate: RecipeBenchmarkComparableRun,
  baselineResults: RecipeBenchmarkComparableResult[],
  candidateResults: RecipeBenchmarkComparableResult[],
): { comparability: RecipeBenchmarkComparability; regression_gate: RegressionGateResult } {
  const baselineManifest = record(baseline.version_manifest);
  const candidateManifest = record(candidate.version_manifest);
  const baselineDefinition = record(baselineManifest.benchmark_definition);
  const candidateDefinition = record(candidateManifest.benchmark_definition);
  const missingBaselineDefinition = canonicalFields.filter((field) =>
    typeof baselineDefinition[field] !== "string");
  const missingCandidateDefinition = canonicalFields.filter((field) =>
    typeof candidateDefinition[field] !== "string");
  const missingDefinition = [
    ...missingBaselineDefinition.map((field) => `baseline.${field}`),
    ...missingCandidateDefinition.map((field) => `candidate.${field}`),
  ];
  const changedDefinition = canonicalFields.filter((field) =>
    typeof baselineDefinition[field] === "string" && typeof candidateDefinition[field] === "string"
      && baselineDefinition[field] !== candidateDefinition[field]);
  const baselineConfigurationFingerprint = typeof baselineManifest.configuration_fingerprint === "string"
    ? baselineManifest.configuration_fingerprint : null;
  const candidateConfigurationFingerprint = typeof candidateManifest.configuration_fingerprint === "string"
    ? candidateManifest.configuration_fingerprint : null;
  const baselineSample = record(baseline.sample_definition);
  const candidateSample = record(candidate.sample_definition);
  const baselineEvaluated = ids(baselineSample.successfully_evaluated_product_ids);
  const candidateEvaluated = ids(candidateSample.successfully_evaluated_product_ids);
  const baselineSelected = ids(baselineSample.selected_product_ids);
  const candidateSelected = ids(candidateSample.selected_product_ids);
  const baselineByProduct = new Map(baselineResults.map((result) => [result.product_id, result]));
  const candidateByProduct = new Map(candidateResults.map((result) => [result.product_id, result]));
  // Result coverage is itself contract evidence: do not silently ignore an
  // orphaned result merely because a malformed manifest omitted its ID.
  const evaluated = new Set([
    ...(baselineEvaluated ?? []), ...(candidateEvaluated ?? []),
    ...baselineByProduct.keys(), ...candidateByProduct.keys(),
  ]);
  const missingBaselineResult: number[] = [], missingCandidateResult: number[] = [];
  const missingBaselineSnapshot: number[] = [], missingCandidateSnapshot: number[] = [];
  const missingBaselineFingerprint: number[] = [], missingCandidateFingerprint: number[] = [], inputDrift: number[] = [];
  for (const productId of [...evaluated].sort((a, b) => a - b)) {
    const left = baselineByProduct.get(productId), right = candidateByProduct.get(productId);
    if (!left) missingBaselineResult.push(productId);
    if (!right) missingCandidateResult.push(productId);
    const leftEvidence = record(left?.evidence_used), rightEvidence = record(right?.evidence_used);
    const leftSnapshot = leftEvidence.production_case_input_snapshot;
    const rightSnapshot = rightEvidence.production_case_input_snapshot;
    const leftFingerprint = typeof leftEvidence.production_case_input_fingerprint === "string" ? leftEvidence.production_case_input_fingerprint : null;
    const rightFingerprint = typeof rightEvidence.production_case_input_fingerprint === "string" ? rightEvidence.production_case_input_fingerprint : null;
    if (left && !validProductionSnapshot(leftSnapshot, productId, leftFingerprint)) missingBaselineSnapshot.push(productId);
    if (right && !validProductionSnapshot(rightSnapshot, productId, rightFingerprint)) missingCandidateSnapshot.push(productId);
    if (left && !leftFingerprint) missingBaselineFingerprint.push(productId);
    if (right && !rightFingerprint) missingCandidateFingerprint.push(productId);
    if (leftFingerprint && rightFingerprint && leftFingerprint !== rightFingerprint) inputDrift.push(productId);
  }
  const baselineGroups = groups(baseline.metrics), candidateGroups = groups(candidate.metrics);
  const missingBaselineGroups = [...candidateGroups.keys()].filter((key) => !baselineGroups.has(key));
  const missingCandidateGroups = [...baselineGroups.keys()].filter((key) => !candidateGroups.has(key));
  const groupCoverage = (value: JsonRecord | undefined) => ({
    product_count: value?.product_count ?? null,
  });
  const changedGroups = [...candidateGroups.keys()].filter((key) =>
    baselineGroups.has(key)
    && JSON.stringify(groupCoverage(baselineGroups.get(key))) !== JSON.stringify(groupCoverage(candidateGroups.get(key))));
  const linkage = record(candidateSample.baseline_linkage);
  const persistedBaselineLinkageUsed = linkage.baseline_run_id === baseline.id;
  const gate = buildRecipeRegressionGate(candidate.metrics, baseline.metrics, baseline.id);
  const persisted = linkage.regression_gate;
  const gateAgrees = persistedBaselineLinkageUsed && persisted != null
    ? JSON.stringify(gateSignature(persisted)) === JSON.stringify(gateSignature(gate)) : null;
  const reasons: string[] = [];
  if (missingBaselineDefinition.length) reasons.push(`The baseline run is missing required canonical benchmark definition fields: ${missingBaselineDefinition.join(", ")}.`);
  if (missingCandidateDefinition.length) reasons.push(`The candidate run is missing required canonical benchmark definition fields: ${missingCandidateDefinition.join(", ")}.`);
  if (changedDefinition.length) reasons.push(`Canonical benchmark definition fields differ: ${changedDefinition.join(", ")}.`);
  if (!baselineConfigurationFingerprint) reasons.push("The baseline run is missing its production configuration fingerprint.");
  if (!candidateConfigurationFingerprint) reasons.push("The candidate run is missing its production configuration fingerprint.");
  if (baselineConfigurationFingerprint && candidateConfigurationFingerprint && baselineConfigurationFingerprint !== candidateConfigurationFingerprint) {
    reasons.push("The production configuration fingerprints differ.");
  }
  if (!baselineSelected) reasons.push("The baseline run is missing its selected Product cohort.");
  if (!candidateSelected) reasons.push("The candidate run is missing its selected Product cohort.");
  if (!baselineEvaluated) reasons.push("The baseline run is missing its evaluated Product coverage.");
  if (!candidateEvaluated) reasons.push("The candidate run is missing its evaluated Product coverage.");
  if (baselineSelected && candidateSelected && !sameIds(baselineSelected, candidateSelected, true)) {
    reasons.push("The selected canonical Product cohorts differ.");
  }
  if (baselineEvaluated && candidateEvaluated && !sameIds(baselineEvaluated, candidateEvaluated)) {
    reasons.push("The evaluated Product coverage differs.");
  }
  if (baselineSelected && baselineEvaluated && !sameIds(baselineSelected, baselineEvaluated)) {
    reasons.push("The baseline selected cohort and evaluated coverage differ.");
  }
  if (candidateSelected && candidateEvaluated && !sameIds(candidateSelected, candidateEvaluated)) {
    reasons.push("The candidate selected cohort and evaluated coverage differ.");
  }
  if (missingBaselineResult.length) reasons.push(`Baseline results are missing for Product IDs: ${missingBaselineResult.join(", ")}.`);
  if (missingCandidateResult.length) reasons.push(`Candidate results are missing for Product IDs: ${missingCandidateResult.join(", ")}.`);
  if (missingBaselineSnapshot.length) reasons.push(`Baseline production input snapshots are missing for Product IDs: ${missingBaselineSnapshot.join(", ")}.`);
  if (missingCandidateSnapshot.length) reasons.push(`Candidate production input snapshots are missing for Product IDs: ${missingCandidateSnapshot.join(", ")}.`);
  if (missingBaselineFingerprint.length) reasons.push(`Baseline production input fingerprints are missing for Product IDs: ${missingBaselineFingerprint.join(", ")}.`);
  if (missingCandidateFingerprint.length) reasons.push(`Candidate production input fingerprints are missing for Product IDs: ${missingCandidateFingerprint.join(", ")}.`);
  if (inputDrift.length) reasons.push(`Production input fingerprints differ for Product IDs: ${inputDrift.join(", ")}.`);
  if (missingBaselineGroups.length) {
    reasons.push(`Canonical format groups are missing from the baseline: ${missingBaselineGroups.join(", ")}.`);
  }
  if (missingCandidateGroups.length) {
    reasons.push(`Canonical format groups are missing from the candidate: ${missingCandidateGroups.join(", ")}.`);
  }
  if (changedGroups.length) {
    reasons.push(`Canonical format-group coverage changed: ${changedGroups.join(", ")}.`);
  }
  if (persistedBaselineLinkageUsed && gateAgrees === false) {
    reasons.push("The persisted baseline regression gate disagrees with the selected pair's authoritative metric gate.");
  }
  const comparable = reasons.length === 0;
  return {
    comparability: { comparable, reasons, changed_canonical_definition_fields: changedDefinition, missing_canonical_definition_fields: missingDefinition,
      production_configuration_match: baselineConfigurationFingerprint && candidateConfigurationFingerprint
        ? baselineConfigurationFingerprint === candidateConfigurationFingerprint
        : null,
      baseline_configuration_fingerprint: baselineConfigurationFingerprint, candidate_configuration_fingerprint: candidateConfigurationFingerprint,
      input_drift_product_ids: inputDrift, missing_baseline_result_product_ids: missingBaselineResult, missing_candidate_result_product_ids: missingCandidateResult,
      missing_baseline_snapshot_product_ids: missingBaselineSnapshot, missing_candidate_snapshot_product_ids: missingCandidateSnapshot,
      missing_baseline_fingerprint_product_ids: missingBaselineFingerprint, missing_candidate_fingerprint_product_ids: missingCandidateFingerprint,
      baseline_only_evaluated_product_ids: (baselineEvaluated ?? []).filter((id) => !(candidateEvaluated ?? []).includes(id)),
      candidate_only_evaluated_product_ids: (candidateEvaluated ?? []).filter((id) => !(baselineEvaluated ?? []).includes(id)),
      missing_baseline_format_groups: missingBaselineGroups, missing_candidate_format_groups: missingCandidateGroups, changed_format_groups: changedGroups,
      persisted_baseline_linkage_used: persistedBaselineLinkageUsed, persisted_regression_gate_agrees: gateAgrees },
    regression_gate: comparable ? gate : { ...gate, status: "incomparable", flagged_formats: [] },
  };
}