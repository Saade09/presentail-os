import {
  generateRecipeSuggestion,
  type RecipeLineInput,
  type RecipeSuggestionTarget,
  type ApprovedContextualRule,
} from "./recipeSuggestionEngine";
import { generateFrozenPreChangeRecipeSuggestion } from "./recipeSuggestionBaselineV2";

export type CompatibilityAuditCase = {
  auditId: string;
  category: "flowers" | "containers" | "balloons" | "packages" | "trusted-source";
  target: RecipeSuggestionTarget;
  candidates: RecipeLineInput[];
  expectedBaseItemId: number | null;
  contextualRules?: ApprovedContextualRule[];
};

const colors = ["Red", "Pink", "White"] as const;

/**
 * Independently authored, read-only cohort-style immutable Product snapshots;
 * this is not a DB-backed historical-product audit. Expected IDs are authored
 * in the fixture rather than derived from matcher output.
 */
export const RECIPE_COMPATIBILITY_AUDIT_21: CompatibilityAuditCase[] = [
  ...colors.map((color, index) => ({
    auditId: `color-${color.toLowerCase()}`,
    category: "flowers" as const,
    target: { id: 10_000 + index, name: `5 ${color} Roses` },
    candidates: [
      { baseItemId: 20_000 + index * 2, baseItemName: `${color} Rose`, quantity: 1 },
      { baseItemId: 20_001 + index * 2, baseItemName: `${colors[(index + 1) % colors.length]} Rose`, quantity: 1 },
    ],
    expectedBaseItemId: 20_000 + index * 2,
  })),
  {
    auditId: "spray-rose", category: "flowers", target: { id: 10_010, name: "5 Red Spray Roses" },
    candidates: [
      { baseItemId: 20_020, baseItemName: "Red Rose", quantity: 1 },
      { baseItemId: 20_021, baseItemName: "Red Spray Rose", quantity: 1 },
    ], expectedBaseItemId: 20_021,
  },
  {
    auditId: "calla-lily", category: "flowers", target: { id: 10_013, name: "5 Calla Lilies" },
    candidates: [
      { baseItemId: 20_026, baseItemName: "Lily", quantity: 1 },
      { baseItemId: 20_027, baseItemName: "Calla Lily", quantity: 1 },
    ], expectedBaseItemId: 20_027,
  },
  ...[40, 60].map((centimeters, index) => ({
    auditId: `stem-${centimeters}`,
    category: "flowers" as const,
    target: { id: 10_020 + index, name: `5 Red Roses, stem length ${centimeters} cm` },
    candidates: [
      { baseItemId: 20_030 + index * 2, baseItemName: `Red Rose ${centimeters}cm`, quantity: 1 },
      { baseItemId: 20_031 + index * 2, baseItemName: `Red Rose ${centimeters + 10}cm`, quantity: 1 },
    ],
    expectedBaseItemId: 20_030 + index * 2,
  })),
  {
    auditId: "round-box", category: "containers", target: { id: 10_030, name: "Round Flower Box" },
    candidates: [
      { baseItemId: 20_040, baseItemName: "Round Flower Box", quantity: 1 },
      { baseItemId: 20_041, baseItemName: "Heart Flower Box", quantity: 1 },
    ], expectedBaseItemId: 20_040,
  },
  {
    auditId: "heart-box", category: "containers", target: { id: 10_031, name: "Heart Flower Box" },
    candidates: [
      { baseItemId: 20_042, baseItemName: "Round Flower Box", quantity: 1 },
      { baseItemId: 20_043, baseItemName: "Heart Flower Box", quantity: 1 },
    ], expectedBaseItemId: 20_043,
  },
  {
    auditId: "glass-vase", category: "containers", target: { id: 10_032, name: "Glass Vase" },
    candidates: [
      { baseItemId: 20_044, baseItemName: "Glass Vase", quantity: 1 },
      { baseItemId: 20_045, baseItemName: "Ceramic Vase", quantity: 1 },
    ], expectedBaseItemId: 20_044,
  },
  {
    auditId: "foil-balloon", category: "balloons", target: { id: 10_033, name: "Foil Balloon" },
    candidates: [
      { baseItemId: 20_046, baseItemName: "Foil Balloon", quantity: 1 },
      { baseItemId: 20_047, baseItemName: "Latex Balloon", quantity: 1 },
    ], expectedBaseItemId: 20_046,
  },
  {
    auditId: "latex-balloon", category: "balloons", target: { id: 10_034, name: "Latex Balloon" },
    candidates: [
      { baseItemId: 20_048, baseItemName: "Foil Balloon", quantity: 1 },
      { baseItemId: 20_049, baseItemName: "Latex Balloon", quantity: 1 },
    ], expectedBaseItemId: 20_049,
  },
  {
    auditId: "alias-contradiction", category: "trusted-source", target: { id: 10_035, name: "Red Rose" },
    candidates: [{
      baseItemId: 20_050, baseItemName: "Pink Rose", quantity: 1,
      metadata: { approvedAliases: ["Red Rose"] },
    }], expectedBaseItemId: null,
  },
  {
    auditId: "recipe-quantity-not-package-size", category: "packages",
    target: { id: 10_040, name: "5 Red Roses" },
    candidates: [
      { baseItemId: 20_060, baseItemName: "Red Roses pack of 12", quantity: 1 },
      { baseItemId: 20_061, baseItemName: "Red Roses pack of 24", quantity: 1 },
    ], expectedBaseItemId: null,
  },
  {
    auditId: "explicit-package-size", category: "packages",
    target: { id: 10_041, name: "Pack of 12 Red Roses" },
    candidates: [
      { baseItemId: 20_062, baseItemName: "Red Roses pack of 12", quantity: 1 },
      { baseItemId: 20_063, baseItemName: "Red Roses pack of 24", quantity: 1 },
    ], expectedBaseItemId: 20_062,
  },
  {
    auditId: "labeled-height-diameter", category: "containers",
    target: { id: 10_042, name: "Glass Vase", description: "Glass vase (20 cm height, 10 cm diameter)" },
    candidates: [
      { baseItemId: 20_064, baseItemName: "Glass Vase height 20.05cm diameter 10cm", quantity: 1 },
      { baseItemId: 20_065, baseItemName: "Glass Vase height 20.2cm diameter 10cm", quantity: 1 },
      { baseItemId: 20_066, baseItemName: "Glass Vase height 20cm diameter 11cm", quantity: 1 },
    ], expectedBaseItemId: 20_064,
  },
  {
    auditId: "contextual-40-missing-stem", category: "flowers",
    target: { id: 10_043, name: "20 Red Roses Flower Box" },
    candidates: [
      { baseItemId: 20_067, baseItemName: "Red Rose 40cm", quantity: 1 },
      { baseItemId: 20_068, baseItemName: "Red Rose 60cm", quantity: 1 },
    ], expectedBaseItemId: 20_067,
    contextualRules: [{ resolverBaseItemId: 20_067, canonicalFormats: ["Flower Box"], ingredientFamily: "rose", color: "red", stemLengthCm: 40 }],
  },
  {
    auditId: "explicit-60-rejects-contextual-40", category: "flowers",
    target: { id: 10_044, name: "Flower Box", description: "Includes:\n• 20 Red Roses, stem length 60 cm" },
    candidates: [
      { baseItemId: 20_069, baseItemName: "Red Rose 40cm", quantity: 1 },
      { baseItemId: 20_070, baseItemName: "Red Rose 60cm", quantity: 1 },
    ], expectedBaseItemId: 20_070,
    contextualRules: [{ resolverBaseItemId: 20_069, canonicalFormats: ["Flower Box"], ingredientFamily: "rose", color: "red", stemLengthCm: 40 }],
  },
  {
    auditId: "sole-unknown-color", category: "trusted-source",
    target: { id: 10_045, name: "5 Red Roses" },
    candidates: [{ baseItemId: 20_071, baseItemName: "Rose", quantity: 1 }],
    expectedBaseItemId: null,
  },
  {
    auditId: "18in-balloon-not-40in", category: "balloons",
    target: { id: 10_046, name: "Celebration Balloon", description: "Foil balloon, 18 inch helium-filled" },
    candidates: [
      { baseItemId: 20_072, baseItemName: "Foil Balloon 18 inch", quantity: 1 },
      { baseItemId: 20_073, baseItemName: "Foil Balloon 40 inch", quantity: 1 },
    ], expectedBaseItemId: 20_072,
  },
  {
    auditId: "real-cohort-style-bundle-text", category: "flowers",
    target: { id: 10_047, name: "Bundle of 30 Pink Roses" },
    candidates: [
      { baseItemId: 20_074, baseItemName: "Pink Rose", quantity: 1 },
      { baseItemId: 20_075, baseItemName: "Red Rose", quantity: 1 },
    ], expectedBaseItemId: 20_074,
  },
];

export function buildRecipeCompatibilityAuditReport() {
  const categorySpecificResults: Record<string, { products: number; matched: number; hardExclusions: number }> = {};
  const products = RECIPE_COMPATIBILITY_AUDIT_21.map((fixture) => {
    const current = generateRecipeSuggestion(fixture.target, [], fixture.candidates, {
      flowerBoxSponge: false,
      balloonMetalRing: false,
    }, undefined, fixture.contextualRules);
    const frozen = generateFrozenPreChangeRecipeSuggestion(fixture.target, [], fixture.candidates);
    const requirement = current.requirements.find((candidate) =>
      (candidate.candidateCompatibility?.length ?? 0) > 0,
    ) ?? current.requirements[0];
    const frozenRequirement = frozen.requirements.find((candidate) =>
      candidate.requirementId === requirement?.requirementId,
    ) ?? frozen.requirements[0];
    const selectedBaseItemId = current.lines[0]?.baseItemId ?? null;
    const frozenSelectedBaseItemId = frozen.lines[0]?.baseItemId ?? null;
    const diagnostics = requirement?.candidateCompatibility ?? [];
    const category = categorySpecificResults[fixture.category] ??= { products: 0, matched: 0, hardExclusions: 0 };
    category.products += 1;
    if (selectedBaseItemId === fixture.expectedBaseItemId) category.matched += 1;
    category.hardExclusions += diagnostics.filter(({ survivor }) => !survivor).length;
    return {
      auditId: fixture.auditId,
      category: fixture.category,
      expectedBaseItemId: fixture.expectedBaseItemId,
      current: {
        requirementId: requirement?.requirementId ?? null,
        phrase: requirement?.phrase ?? null,
        quantity: requirement?.quantity ?? null,
        explicitAttributes: requirement?.attributes ?? {},
        candidates: diagnostics,
        survivors: requirement?.candidateBaseItemIds ?? [],
        resolution: requirement?.resolution ?? "no_match",
        selectedBaseItemId,
      },
      frozenPhase1: {
        requirementId: frozenRequirement?.requirementId ?? null,
        resolution: frozenRequirement?.resolution ?? "no_match",
        selectedBaseItemId: frozenSelectedBaseItemId,
      },
    };
  });
  const frozenCorrect = (record: typeof products[number]) =>
    record.frozenPhase1.selectedBaseItemId === record.expectedBaseItemId;
  const currentCorrect = (record: typeof products[number]) =>
    record.current.selectedBaseItemId === record.expectedBaseItemId;
  return {
    products,
    summary: {
      productsEvaluated: products.length,
      unknownSurvivors: products.flatMap(({ current }) => current.candidates)
        .filter(({ survivor, hasUnknownExplicitDiscriminator }) => survivor && hasUnknownExplicitDiscriminator).length,
      newAutomaticResolutions: products.filter((record) =>
        record.current.resolution === "matched" && record.frozenPhase1.resolution !== "matched").map(({ auditId }) => auditId),
      saferOutcomes: products.filter((record) =>
        record.current.resolution !== "matched" && record.frozenPhase1.resolution === "matched").map(({ auditId }) => auditId),
      accidentalRemovals: products.filter((record) => !currentCorrect(record) && frozenCorrect(record)).map(({ auditId }) => auditId),
      regressionsVsFrozenPhase1: products.filter((record) =>
        !currentCorrect(record) && frozenCorrect(record)).map(({ auditId }) => auditId),
      hardRemovalsByAttribute: products.flatMap(({ current }) => current.candidates)
        .flatMap(({ comparisons }) => Object.entries(comparisons))
        .reduce<Record<string, number>>((summary, [attribute, comparison]) => {
          if (comparison.state === "incompatible") summary[attribute] = (summary[attribute] ?? 0) + 1;
          return summary;
        }, {}),
      categorySpecificResults,
    },
  };
}