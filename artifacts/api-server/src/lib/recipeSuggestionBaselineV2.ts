/**
 * Frozen pre-change benchmark implementation.
 *
 * Do not refactor this module to share matching helpers with the live engine:
 * isolation is what makes historical benchmark results comparable after the
 * live matcher changes. This implementation intentionally reflects the old
 * English phrase matcher and does not use structured contextual resolution.
 */
import type {
  OperationalRuleActivation,
  ProductStructure,
  RecipeLineInput,
  RecipeSuggestion,
  RecipeSuggestionTarget,
  SuggestionProduct,
} from "./recipeSuggestionEngine";

export const FROZEN_RECIPE_BASELINE_V2 = "benchmark-deterministic-v2-requirement-aware";

const normalize = (value: unknown) => String(value ?? "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const tokenSet = (value: unknown) => new Set(normalize(value).split(" ").filter((token) => token.length > 1));
const singular = (value: string) => value.endsWith("ies")
  ? `${value.slice(0, -3)}y`
  : value.endsWith("s") && !value.endsWith("ss") ? value.slice(0, -1) : value;
const matchingSet = (value: unknown) => new Set([...tokenSet(value)].map(singular));

function similarity(target: RecipeSuggestionTarget, candidate: SuggestionProduct): number {
  const left = tokenSet([target.name, target.description, target.category, ...(target.tags ?? [])].join(" "));
  const right = tokenSet([candidate.name, candidate.description, candidate.category, ...(candidate.tags ?? [])].join(" "));
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  let score = intersection / new Set([...left, ...right]).size;
  const productType = (value: RecipeSuggestionTarget | SuggestionProduct) => {
    const text = normalize([value.name, value.description, value.category].join(" "));
    if (text.includes("balloon")) return "balloon";
    if (text.includes("flower box") || text.includes("flowerbox") || text.includes("box")) return "box";
    if (text.includes("bouquet")) return "bouquet";
    if (text.includes("basket")) return "basket";
    if (text.includes("vase")) return "vase";
    if (text.includes("plant")) return "plant";
    return "other";
  };
  if (productType(target) === productType(candidate)) score += 0.25;
  if (target.category && candidate.category && normalize(target.category) === normalize(candidate.category)) score += 0.2;
  return Math.min(1, score);
}

function frozenStructure(): ProductStructure {
  const unknown = { value: null, sourcePhrases: [], language: "unknown" as const, confidence: "no_match" as const };
  return {
    ingredientFamily: unknown,
    ingredientType: unknown,
    color: unknown,
    quantity: unknown,
    packageCount: unknown,
    container: unknown,
    productFormat: { value: "Unknown", sourcePhrases: [], language: "unknown", confidence: "no_match" },
    formatResolution: {
      observations: [],
      deduplicatedResolutionEvidence: [],
      resolvedPrimaryFormat: null,
      authoritativePrimaryFormat: null,
      contextualRuleFormatEligible: false,
      wrapperFormats: [],
      disagreements: [],
      unresolvedReason: "Frozen v2 baseline did not perform semantic format resolution.",
    },
    material: unknown,
    shape: unknown,
    stemLength: unknown,
    dimensions: [],
    classificationEvidence: [],
    conflicts: [],
    uncertainty: ["Frozen v2 baseline did not emit structured requirements."],
  };
}

export function generateFrozenPreChangeRecipeSuggestion(
  target: RecipeSuggestionTarget,
  supportingProducts: SuggestionProduct[],
  baseItems: RecipeLineInput[],
  _activeRules?: OperationalRuleActivation,
): RecipeSuggestion {
  const targetText = normalize([target.name, target.description, target.category, ...(target.tags ?? [])].join(" "));
  const targetTokens = matchingSet(targetText);
  const exactCodeLines = baseItems.filter((item) => {
    const code = normalize(item.baseItemCode);
    return code.length > 2 && new RegExp(`(?:^|\\s)${code.replace(/ /g, "\\s+")}(?:\\s|$)`).test(targetText);
  });
  const candidates = baseItems.filter((item) => {
    if (exactCodeLines.some((line) => line.baseItemId === item.baseItemId)) return false;
    const required = [...matchingSet(item.baseItemName)];
    return required.length > 0 && required.every((token) => targetTokens.has(token));
  });
  const maximal = candidates.filter((candidate) =>
    !candidates.some((other) =>
      other.baseItemId !== candidate.baseItemId
      && tokenSet(other.baseItemName).size > tokenSet(candidate.baseItemName).size
      && [...tokenSet(candidate.baseItemName)].every((token) => tokenSet(other.baseItemName).has(token)),
    ),
  );
  const grouped = new Map<string, RecipeLineInput[]>();
  for (const candidate of maximal) {
    const key = [...tokenSet(candidate.baseItemName)].sort().join("|");
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const lines: RecipeSuggestion["lines"] = exactCodeLines.map((item) => ({
    ...item,
    quantity: 1,
    confidence: "high",
    source: "deterministic_rule",
    reason: "Base Item code appears in product data.",
    hiddenRuleKey: null,
    unresolved: false,
  }));
  const unresolvedRequirements: RecipeSuggestion["unresolvedRequirements"] = [];
  const unresolvedLines: string[] = [];
  for (const group of grouped.values()) {
    if (group.length !== 1) {
      unresolvedRequirements.push({
        requirementId: `frozen-v2:ambiguous:${unresolvedRequirements.length}`,
        requirement: group.map((item) => item.baseItemName).join(" / "),
        quantity: 1,
        reason: "Frozen v2 phrase matching found multiple variants.",
        candidateBaseItemIds: group.map((item) => item.baseItemId),
      });
      continue;
    }
    const item = group[0];
    const quantityMatch = targetText.match(new RegExp(`(?:^|\\s)(\\d+)\\s+(?:${normalize(item.baseItemName).replace(/ /g, "\\s+")})`));
    lines.push({
      ...item,
      quantity: quantityMatch ? Number(quantityMatch[1]) : 1,
      confidence: "high",
      source: "deterministic_rule",
      reason: "Frozen v2 normalized phrase match.",
      hiddenRuleKey: null,
      unresolved: false,
    });
  }

  const rankedSimilar = supportingProducts
    .filter((product) => product.id !== target.id)
    .map((product) => ({ product, score: similarity(target, product) }))
    .filter(({ score }) => score >= 0.2)
    .sort((a, b) => b.score - a.score || a.product.id - b.product.id)
    .slice(0, 5);
  const support = new Map<number, { item: RecipeLineInput; quantities: number[]; productIds: number[] }>();
  for (const { product } of rankedSimilar) {
    for (const item of product.recipes) {
      const evidence = support.get(item.baseItemId) ?? { item, quantities: [], productIds: [] };
      evidence.quantities.push(item.quantity);
      evidence.productIds.push(product.id);
      support.set(item.baseItemId, evidence);
    }
  }
  const conflicts: RecipeSuggestion["conflicts"] = [];
  for (const [baseItemId, evidence] of support) {
    const quantities = [...new Set(evidence.quantities)];
    if (quantities.length > 1) {
      conflicts.push({
        baseItemId,
        baseItemName: evidence.item.baseItemName,
        quantities,
        supportingProductIds: evidence.productIds,
      });
    } else if (evidence.quantities.length >= 2 && !lines.some((line) => line.baseItemId === baseItemId)) {
      lines.push({
        ...evidence.item,
        quantity: quantities[0],
        confidence: evidence.quantities.length >= 3 ? "high" : "medium",
        source: "similar_product",
        reason: `Supported by ${evidence.quantities.length} similar approved product recipe(s).`,
        hiddenRuleKey: null,
        unresolved: false,
      });
    }
  }

  const activeRules = _activeRules ?? { flowerBoxSponge: true, balloonMetalRing: true };
  if (activeRules.balloonMetalRing) {
    const count = [...targetText.matchAll(/(\d+(?:\.\d+)?)\s+(?:latex|foil|physical)?\s*balloons?/g)]
      .reduce((total, match) => total + Number(match[1]), 0);
    const ring = baseItems.find((item) => normalize(item.baseItemName).includes("metal ring"));
    if (count > 0 && ring && !lines.some((line) => line.baseItemId === ring.baseItemId)) {
      lines.push({
        ...ring,
        quantity: count,
        confidence: "high",
        source: "deterministic_rule",
        reason: "Confirmed rule: one metal ring per physical balloon.",
        hiddenRuleKey: "balloon_metal_ring",
        unresolved: false,
      });
    }
  }
  if (activeRules.flowerBoxSponge) {
    const size = targetText.includes("extra large") || targetText.includes("xl")
      ? "extra_large"
      : targetText.includes("large") ? "large" : targetText.includes("medium") ? "medium" : null;
    const round = targetText.includes("round") && targetText.includes("box");
    const heart = targetText.includes("heart") && targetText.includes("box");
    const spongeQuantity = round && size === "medium" ? 1
      : round && size === "large" ? 2
        : round && size === "extra_large" ? 3
          : heart && size === "medium" ? 1
            : heart && size === "extra_large" ? 5 : null;
    const sponge = baseItems.find((item) => normalize(item.baseItemName).includes("floral sponge"));
    if (spongeQuantity != null && sponge && !lines.some((line) => line.baseItemId === sponge.baseItemId)) {
      lines.push({
        ...sponge,
        quantity: spongeQuantity,
        confidence: "high",
        source: "deterministic_rule",
        reason: `Confirmed ${round ? "round" : "heart"} flower-box rule for ${size?.replace("_", " ")} size.`,
        hiddenRuleKey: `flower_box_${round ? "round" : "heart"}_${size}_sponge`,
        unresolved: false,
      });
    } else if (size && (round || heart) && spongeQuantity == null) {
      unresolvedRequirements.push({
        requirementId: "frozen-v2:packaging-review",
        requirement: "Packaging rule requires review",
        quantity: 1,
        reason: "The product size does not map to a confirmed packaging quantity.",
      });
      unresolvedLines.push("Packaging rule requires review");
    }
  }

  for (const requirement of unresolvedRequirements) {
    if (!unresolvedLines.includes(requirement.requirement)) unresolvedLines.push(requirement.requirement);
  }
  if (lines.length === 0 && unresolvedLines.length === 0) {
    unresolvedLines.push("No existing Base Item or similar approved recipe matched this product.");
    unresolvedRequirements.push({
      requirementId: "frozen-v2:no-match",
      requirement: unresolvedLines[0],
      quantity: 1,
      reason: "Frozen v2 found no normalized phrase match.",
    });
  }
  return {
    targetProductId: target.id,
    engineVersion: FROZEN_RECIPE_BASELINE_V2,
    structure: frozenStructure(),
    requirements: [],
    lines,
    similarProducts: rankedSimilar.map(({ product, score }) => ({
      productId: product.id,
      name: product.name,
      score: Number(score.toFixed(4)),
    })),
    conflicts,
    unresolvedLines,
    unresolvedRequirements,
    evidenceSummary: {
      deterministic_rule: lines.length,
      similar_product: lines.filter((line) => line.source === "similar_product").length,
      ai_assisted: 0,
      unresolved: unresolvedLines.length,
      conflict: conflicts.length,
    },
    leaveOneOut: {
      directRecipeWithheld: true,
      excludedProductId: target.id,
      supportingProductIds: rankedSimilar.map(({ product }) => product.id),
    },
    ruleSetVersion: "confirmed-operational-rules-v1",
  };
}