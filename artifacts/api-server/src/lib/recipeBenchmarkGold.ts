import {
  deterministicRecipeFingerprint,
  type CanonicalProductFormat,
} from "./recipeSuggestionEngine";

export type RecipeBenchmarkGoldLine = {
  requirement_key: string;
  kind: "ingredient" | "container" | "component";
  subtype: string | null;
  source: {
    field: "name" | "description" | "description_ar";
    occurrence: number;
    exact_phrase: string;
    normalized_phrase: string;
    span?: { start: number; end: number };
  };
  source_phrase: string;
  semantic_attributes?: {
    semantic_key?: string;
    category?: string | null;
    ingredient_family?: string | null;
    color?: string | null;
    stem_length_cm?: number | null;
    format?: CanonicalProductFormat | null;
  };
  quantity: number;
  unit: string | null;
  expected_base_item_id: number | null;
  expected_base_item_name: string;
};

export type RecipeBenchmarkHiddenRuleGold = {
  rule_key: string;
  expected: boolean;
  expected_count?: number;
  acceptable_base_item_ids?: readonly number[];
  reason: string;
};

export type RecipeBenchmarkGoldCase = {
  product_id: number;
  author_kind: "agent";
  state: "draft";
  gold_review: {
    state: "draft" | "reviewed" | "adjudicated" | "needs_human_confirmation";
    author_kind: "agent" | "human" | "imported";
    author_identity: string | null;
    reviewer_identity: string | null;
    adjudication_state: "not_required" | "pending" | "completed";
    evidence_basis: readonly string[];
    version: string;
  };
  canonical_fingerprint: null;
  provisional_fingerprint: string;
  final_recipe_expectation: {
    disposition: "complete" | "partial_catalog_coverage";
    lines: readonly RecipeBenchmarkGoldLine[];
    acceptable_variants?: readonly {
      variant_id: string;
      lines: readonly RecipeBenchmarkGoldLine[];
      evidence_basis: readonly string[];
      hidden_rules?: readonly RecipeBenchmarkHiddenRuleGold[];
      disposition?: "complete" | "partial_catalog_coverage";
    }[];
    excluded_observed_recipe_lines: readonly { base_item_id: number; reason: string }[];
  };
  candidate_retrieval_gold: readonly {
    requirement_key: string;
    relevant_base_item_ids: readonly number[];
    catalog_gap: boolean;
    expected_resolution_outcome?: "resolved" | "ambiguous" | "no_match";
  }[];
  compatibility_gold: readonly {
    requirement_key: string;
    candidate_base_item_id: number;
    expected: "compatible" | "incompatible" | "unknown";
    reason: string;
  }[];
  hidden_rules: readonly RecipeBenchmarkHiddenRuleGold[];
  format_gold?: {
    authoritative_product_format?: CanonicalProductFormat | null;
    conflict_expected?: boolean;
    expected_resolved_primary_format?: CanonicalProductFormat | null;
  };
  contextual_resolver_gold?: readonly {
    requirement_key: string;
    rule_key: string;
    expected_outcome: "applied" | "rejected";
    expected_base_item_id?: number | null;
  }[];
  provenance: {
    authored_from_matcher_output: false;
    sources: readonly string[];
    limitations: readonly string[];
  };
};

type UnfingerprintedGold = Omit<RecipeBenchmarkGoldCase, "provisional_fingerprint" | "gold_review">;

function draft(caseData: UnfingerprintedGold): RecipeBenchmarkGoldCase {
  const finalRecipeExpectation = {
    ...caseData.final_recipe_expectation,
    acceptable_variants: caseData.final_recipe_expectation.acceptable_variants ?? [{
      variant_id: `${caseData.product_id}-draft-v1`,
      lines: caseData.final_recipe_expectation.lines,
      evidence_basis: [
        "Explicit Product structural language.",
        "Active catalog facts used only for candidate identity and compatibility.",
      ],
    }],
  };
  return {
    ...caseData,
    gold_review: {
      state: "draft",
      author_kind: "agent",
      author_identity: null,
      reviewer_identity: null,
      adjudication_state: "pending",
      evidence_basis: caseData.provenance.sources,
      version: "expanded-v1-agent-draft",
    },
    final_recipe_expectation: finalRecipeExpectation,
    provisional_fingerprint: deterministicRecipeFingerprint({
      fingerprint_kind: "provisional_agent_gold",
      ...caseData,
      final_recipe_expectation: finalRecipeExpectation,
    }),
  };
}

export function recipeBenchmarkGoldLine(line: RecipeBenchmarkGoldLine): RecipeBenchmarkGoldLine {
  if (!Number.isInteger(line.source.occurrence) || line.source.occurrence < 1) {
    throw new Error("Recipe benchmark gold source occurrences are 1-based positive integers.");
  }
  return {
    ...line,
    source: {
      ...line.source,
      normalized_phrase: line.source.normalized_phrase.trim().toLowerCase().replace(/\s+/g, " "),
    },
  };
}

function botanicalGoldLine(
  line: Omit<RecipeBenchmarkGoldLine, "kind" | "subtype" | "source">,
): RecipeBenchmarkGoldLine {
  return recipeBenchmarkGoldLine({
    ...line,
    kind: "ingredient",
    subtype: "botanical",
    source: {
      field: "description",
      occurrence: 1,
      exact_phrase: line.source_phrase,
      normalized_phrase: line.source_phrase,
    },
  });
}

const commonProvenance = {
  authored_from_matcher_output: false,
  sources: [
    "Read-only Product name and description facts observed in the development database.",
    "Read-only active Base Item catalog facts observed in the same workspace.",
    "Read-only Product Recipe lines used only to identify and document source conflicts.",
  ],
  limitations: [
    "No image was treated as ingredient evidence.",
    "No matcher output was run or inspected while authoring this gold.",
    "Agent-authored expectations are provisional and require human promotion before becoming canonical.",
  ],
} as const;

const noHiddenRules = [
  {
    rule_key: "flower_box_sponge",
    expected: false,
    reason: "Source text does not establish a Flower Box.",
  },
  {
    rule_key: "balloon_metal_ring",
    expected: false,
    reason: "Source text does not establish a Balloon Product.",
  },
] as const;

export const RECIPE_BENCHMARK_GOLD_EXPANDED_V1: readonly RecipeBenchmarkGoldCase[] = [
  draft({
    product_id: 2,
    author_kind: "agent",
    state: "draft",
    canonical_fingerprint: null,
    final_recipe_expectation: {
      disposition: "complete",
      lines: [
        botanicalGoldLine({ requirement_key: "red-rose", source_phrase: "20 red roses", quantity: 20, unit: null, expected_base_item_id: 1, expected_base_item_name: "Red Rose" }),
      ],
      excluded_observed_recipe_lines: [],
    },
    candidate_retrieval_gold: [
      { requirement_key: "red-rose", relevant_base_item_ids: [1], catalog_gap: false },
    ],
    compatibility_gold: [
      { requirement_key: "red-rose", candidate_base_item_id: 1, expected: "compatible", reason: "Canonical name matches the explicit type and color." },
      { requirement_key: "red-rose", candidate_base_item_id: 3, expected: "incompatible", reason: "White conflicts with explicit red." },
      { requirement_key: "red-rose", candidate_base_item_id: 4, expected: "incompatible", reason: "Pink conflicts with explicit red." },
    ],
    hidden_rules: noHiddenRules,
    provenance: commonProvenance,
  }),
  draft({
    product_id: 3,
    author_kind: "agent",
    state: "draft",
    canonical_fingerprint: null,
    final_recipe_expectation: {
      disposition: "complete",
      lines: [
        botanicalGoldLine({ requirement_key: "white-rose", source_phrase: "20 white roses", quantity: 20, unit: null, expected_base_item_id: 3, expected_base_item_name: "White Rose" }),
      ],
      excluded_observed_recipe_lines: [],
    },
    candidate_retrieval_gold: [
      { requirement_key: "white-rose", relevant_base_item_ids: [3], catalog_gap: false },
    ],
    compatibility_gold: [
      { requirement_key: "white-rose", candidate_base_item_id: 3, expected: "compatible", reason: "Canonical name matches the explicit type and color." },
      { requirement_key: "white-rose", candidate_base_item_id: 1, expected: "incompatible", reason: "Red conflicts with explicit white." },
    ],
    hidden_rules: noHiddenRules,
    provenance: commonProvenance,
  }),
  draft({
    product_id: 4,
    author_kind: "agent",
    state: "draft",
    canonical_fingerprint: null,
    final_recipe_expectation: {
      disposition: "complete",
      lines: [
        botanicalGoldLine({ requirement_key: "pink-rose", source_phrase: "20 pink roses", quantity: 20, unit: null, expected_base_item_id: 4, expected_base_item_name: "Pink Rose" }),
      ],
      excluded_observed_recipe_lines: [
        { base_item_id: 7, reason: "Observed Pink Tulip Recipe line conflicts with the explicit Product phrase '20 pink roses'." },
      ],
    },
    candidate_retrieval_gold: [
      { requirement_key: "pink-rose", relevant_base_item_ids: [4], catalog_gap: false },
    ],
    compatibility_gold: [
      { requirement_key: "pink-rose", candidate_base_item_id: 4, expected: "compatible", reason: "Canonical name matches the explicit type and color." },
      { requirement_key: "pink-rose", candidate_base_item_id: 7, expected: "incompatible", reason: "Tulip conflicts with explicit rose." },
    ],
    hidden_rules: noHiddenRules,
    provenance: {
      ...commonProvenance,
      limitations: [...commonProvenance.limitations, "The persisted approved Recipe conflicts with Product language and was not promoted to canonical gold."],
    },
  }),
  draft({
    product_id: 49,
    author_kind: "agent",
    state: "draft",
    canonical_fingerprint: null,
    final_recipe_expectation: {
      disposition: "partial_catalog_coverage",
      lines: [
        botanicalGoldLine({ requirement_key: "white-rose", source_phrase: "4 white roses", quantity: 4, unit: null, expected_base_item_id: 3, expected_base_item_name: "White Rose" }),
        botanicalGoldLine({ requirement_key: "white-eustoma", source_phrase: "1 stem of white eustoma", quantity: 1, unit: "stem", expected_base_item_id: null, expected_base_item_name: "White Eustoma" }),
        botanicalGoldLine({ requirement_key: "green-hypericum", source_phrase: "1 stem of green hypericum", quantity: 1, unit: "stem", expected_base_item_id: null, expected_base_item_name: "Green Hypericum" }),
        botanicalGoldLine({ requirement_key: "green-mist", source_phrase: "1 stem of green mist", quantity: 1, unit: "stem", expected_base_item_id: null, expected_base_item_name: "Green Mist" }),
        botanicalGoldLine({ requirement_key: "green-trachelium", source_phrase: "2 stems of green trachelium", quantity: 2, unit: "stems", expected_base_item_id: null, expected_base_item_name: "Green Trachelium" }),
        botanicalGoldLine({ requirement_key: "asparagus", source_phrase: "1 stem of asparagus", quantity: 1, unit: "stem", expected_base_item_id: null, expected_base_item_name: "Asparagus" }),
      ],
      excluded_observed_recipe_lines: [
        { base_item_id: 9, reason: "Observed Purple Tulip is not present in Product language." },
        { base_item_id: 13, reason: "Observed Sunflower is not present in Product language." },
      ],
    },
    candidate_retrieval_gold: [
      { requirement_key: "white-rose", relevant_base_item_ids: [3], catalog_gap: false },
      { requirement_key: "white-eustoma", relevant_base_item_ids: [], catalog_gap: true },
      { requirement_key: "green-hypericum", relevant_base_item_ids: [], catalog_gap: true },
      { requirement_key: "green-mist", relevant_base_item_ids: [], catalog_gap: true },
      { requirement_key: "green-trachelium", relevant_base_item_ids: [], catalog_gap: true },
      { requirement_key: "asparagus", relevant_base_item_ids: [], catalog_gap: true },
    ],
    compatibility_gold: [
      { requirement_key: "white-rose", candidate_base_item_id: 3, expected: "compatible", reason: "Canonical name matches the explicit type and color." },
      { requirement_key: "white-rose", candidate_base_item_id: 9, expected: "incompatible", reason: "Purple Tulip conflicts with white rose." },
      { requirement_key: "white-rose", candidate_base_item_id: 13, expected: "incompatible", reason: "Sunflower conflicts with white rose." },
    ],
    hidden_rules: noHiddenRules,
    provenance: {
      ...commonProvenance,
      limitations: [
        ...commonProvenance.limitations,
        "Five explicit ingredients have no corresponding active Base Item in the observed catalog.",
        "Those observed catalog gaps are not definitive no-match gold because the intended workspace catalog is unavailable; their Base Item resolution and final-Recipe exactness remain unscored.",
        "The two persisted Recipe lines conflict with Product language and were not promoted to canonical gold.",
      ],
    },
  }),
] as const;

export const RECIPE_BENCHMARK_GOLD_BY_PRODUCT_ID = new Map(
  RECIPE_BENCHMARK_GOLD_EXPANDED_V1.map((entry) => [entry.product_id, entry] as const),
);