import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";

export type MetricCount = {
  evaluated?: number;
  correct?: number;
  accuracy?: number | null;
};

export type FormatMetric = {
  format?: string;
  category?: string;
  product_count?: number;
  scored_product_count?: number;
  base_item_f1?: number | null;
  quantity_accuracy?: MetricCount;
  full_recipe_exact_match?: MetricCount;
};

export type RegressionGate = {
  status?: "pass" | "flagged" | "no_baseline" | "incomparable";
  baseline_run_id?: number | null;
  flagged_formats?: Array<{
    format?: string;
    category?: string;
    baseline?: FormatMetric;
    current?: FormatMetric;
    reasons?: string[];
  }>;
  reason?: string;
  input_drift_product_ids?: number[];
  missing_baseline_snapshot_product_ids?: number[];
  changed_canonical_definition_fields?: string[];
  changed_production_configuration_fields?: string[];
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

export type RecipeBenchmarkRun = {
  id: number;
  status: "completed";
  engine_version: string;
  version_manifest?: Record<string, unknown>;
  sample_definition?: {
    mode?: string;
    selected_product_ids?: number[];
    baseline_linkage?: {
      baseline_run_id?: number | null;
      baseline_engine_version?: string | null;
      same_frozen_cohort?: boolean;
      immutable_inputs_match?: boolean | null;
      production_configuration_match?: boolean | null;
      regression_gate?: RegressionGate;
    };
  };
  sample_composition?: Record<string, number>;
  exclusions?: Array<{
    product_id?: number;
    reason?: string;
    classification?: string;
    rationale?: string;
  }>;
  metrics?: {
    canonical_metrics?: {
      base_item_resolution?: { f1?: number | null };
    };
    estimated_manual_review_burden?: {
      canonical?: {
        review_rate?: number | null;
        average_edits_per_product?: number | null;
        products_requiring_review?: number;
        product_denominator?: number;
      };
    };
    confidence_calibration?: {
      bands?: Record<string, MetricCount>;
    };
    canonical_format_groups?: FormatMetric[];
    regression_gate_inputs?: {
      canonical_format_groups?: FormatMetric[];
    };
  };
  limitations?: string[];
  created_at: string;
  completed_at: string | null;
};

export type RecipeBenchmarkResult = {
  run_id?: number;
  product_id: number;
  product_snapshot?: {
    name?: string;
    category?: string;
    canonical_format?: string;
  };
  evidence_used?: {
    benchmark_case_input_fingerprint?: string;
  };
  comparison?: {
    baseItem?: { f1?: number | null };
    missingItems?: Array<{ baseItemName?: string; quantity?: number }>;
    incorrectExtras?: Array<{ baseItemName?: string; quantity?: number }>;
  };
  created_at: string;
};

export type CanonicalRecipeFailure = {
  product_id: number;
  product_snapshot: {
    name?: string;
    category?: string;
    canonical_format?: string;
  } | null;
  product_name: string | null;
  category: string | null;
  canonical_format: string | null;
  stages: Array<{
    stage: string;
    affected_requirements: Array<{
      expected_requirement_id?: string | null;
      actual_requirement_id?: string | null;
    }>;
  }>;
};

export type RecipeBenchmarkResponse = {
  run: RecipeBenchmarkRun;
  results: RecipeBenchmarkResult[];
};

export type RecipeBenchmarkComparisonResponse = {
  baseline: RecipeBenchmarkResponse;
  candidate: RecipeBenchmarkResponse;
  comparability: RecipeBenchmarkComparability;
  regression_gate: RegressionGate;
  canonical_failures: CanonicalRecipeFailure[];
};

export function useRecipeBenchmarkRuns() {
  return useQuery<{ runs: RecipeBenchmarkRun[] }>({
    queryKey: ["recipe-benchmark-runs"],
    queryFn: () => apiFetch("/api/products/recipe-benchmarks"),
  });
}

export function useRecipeBenchmark(id: number | null) {
  return useQuery<RecipeBenchmarkResponse>({
    queryKey: ["recipe-benchmark", id],
    queryFn: () => apiFetch(`/api/products/recipe-benchmarks/${id}`),
    enabled: id !== null && Number.isInteger(id),
  });
}

export function useRecipeBenchmarkComparison(baselineId: number | null, candidateId: number | null) {
  return useQuery<RecipeBenchmarkComparisonResponse>({
    queryKey: ["recipe-benchmark-comparison", baselineId, candidateId],
    queryFn: () => apiFetch(
      `/api/products/recipe-benchmarks/compare?baseline_run_id=${baselineId}&candidate_run_id=${candidateId}`,
    ),
    enabled: baselineId !== null
      && candidateId !== null
      && Number.isInteger(baselineId)
      && Number.isInteger(candidateId)
      && baselineId !== candidateId,
  });
}