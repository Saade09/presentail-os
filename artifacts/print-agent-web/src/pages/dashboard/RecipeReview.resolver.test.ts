import { describe, expect, it } from "vitest";
import { contextualResolverBaseItemId } from "./RecipeReview";

describe("contextualResolverBaseItemId", () => {
  it("prefers the canonical resolver field", () => {
    expect(contextualResolverBaseItemId({
      resolver_base_item_id: 7,
      base_item_id: 8,
      baseItemId: 9,
    })).toBe(7);
  });

  it("falls back to the legacy snake-case resolver field", () => {
    expect(contextualResolverBaseItemId({ base_item_id: 8, baseItemId: 9 })).toBe(8);
  });

  it("falls back to the legacy camel-case resolver field", () => {
    expect(contextualResolverBaseItemId({ baseItemId: 9 })).toBe(9);
  });
});