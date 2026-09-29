export type RecipeLearningKind = "alias" | "metadata" | "contextual_rule";

export type RecipeLearningScope =
  | "exact_phrase"
  | "one_base_item"
  | "ingredient_color_combination"
  | "canonical_product_format"
  | "dimension_pattern"
  | "workspace_wide_rule";

type ScopeOption = {
  value: RecipeLearningScope;
  label: string;
};

const LEARNING_SCOPE_OPTIONS: Record<RecipeLearningKind, readonly ScopeOption[]> = {
  alias: [
    { value: "exact_phrase", label: "Exact phrase" },
    { value: "one_base_item", label: "One Base Item" },
  ],
  metadata: [
    { value: "one_base_item", label: "One Base Item (required)" },
  ],
  contextual_rule: [
    { value: "exact_phrase", label: "Exact phrase" },
    { value: "ingredient_color_combination", label: "Ingredient/color combination" },
    { value: "canonical_product_format", label: "Canonical Product format" },
    { value: "dimension_pattern", label: "Dimension pattern" },
    { value: "workspace_wide_rule", label: "Workspace-wide rule" },
  ],
};

export function learningScopeOptions(kind: RecipeLearningKind): readonly ScopeOption[] {
  return LEARNING_SCOPE_OPTIONS[kind];
}

export function defaultLearningScope(kind: RecipeLearningKind): RecipeLearningScope {
  return LEARNING_SCOPE_OPTIONS[kind][0].value;
}