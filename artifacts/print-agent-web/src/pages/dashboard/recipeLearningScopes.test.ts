import { describe, expect, it } from "vitest";
import { defaultLearningScope, learningScopeOptions } from "./recipeLearningScopes";

describe("Recipe learning scopes", () => {
  it("shows only scopes supported by each learning type", () => {
    expect(learningScopeOptions("alias").map(({ value }) => value)).toEqual([
      "exact_phrase",
      "one_base_item",
    ]);
    expect(learningScopeOptions("metadata").map(({ value }) => value)).toEqual([
      "one_base_item",
    ]);
    expect(learningScopeOptions("contextual_rule").map(({ value }) => value)).toEqual([
      "exact_phrase",
      "ingredient_color_combination",
      "canonical_product_format",
      "dimension_pattern",
      "workspace_wide_rule",
    ]);
  });

  it("selects a valid scope when the learning type changes", () => {
    expect(defaultLearningScope("alias")).toBe("exact_phrase");
    expect(defaultLearningScope("metadata")).toBe("one_base_item");
    expect(defaultLearningScope("contextual_rule")).toBe("exact_phrase");
  });
});