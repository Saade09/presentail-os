import { describe, expect, it } from "vitest";
import {
  compareRecipeSuggestion,
  CANONICAL_PRODUCT_FORMATS,
  extractRecipeRequirements,
  extractProductStructure,
  generateRecipeSuggestion,
  isGovernedOperationalHiddenRuleKey,
  productType,
  resolveProductFormat,
  runProductionRecipeMatcher,
  type RecipeLineInput,
  type SuggestionProduct,
} from "./recipeSuggestionEngine";

describe("governed operational hidden rule keys", () => {
  it("accepts only the deterministic Sponge/Metal Ring keys", () => {
    expect(isGovernedOperationalHiddenRuleKey("balloon_metal_ring")).toBe(true);
    expect(isGovernedOperationalHiddenRuleKey("flower_box_round_medium_sponge")).toBe(true);
    expect(isGovernedOperationalHiddenRuleKey("arbitrary_hidden_rule")).toBe(false);
  });
});
import { generateFrozenPreChangeRecipeSuggestion } from "./recipeSuggestionBaselineV2";

const baseItems: RecipeLineInput[] = [
  { baseItemId: 1, baseItemName: "Red Roses", baseItemCode: "ROSE-RED", quantity: 1 },
  { baseItemId: 2, baseItemName: "Medium Round Flower Box", baseItemCode: "BOX-M", quantity: 1 },
  { baseItemId: 3, baseItemName: "Floral Sponge", baseItemCode: "SPONGE", quantity: 1 },
  { baseItemId: 4, baseItemName: "Metal Ring", baseItemCode: "RING", quantity: 1 },
  { baseItemId: 5, baseItemName: "Latex Balloon", baseItemCode: "BALLOON", quantity: 1 },
];

function product(overrides: Partial<SuggestionProduct> = {}): SuggestionProduct {
  return {
    id: 100,
    name: "Medium Round Flower Box with 20 Red Roses",
    description: null,
    category: "Flowers",
    tags: [],
    recipes: [],
    ...overrides,
  };
}

function generationTarget(overrides: Partial<SuggestionProduct> = {}) {
  const { recipes: _recipes, ...target } = product(overrides);
  return target;
}

describe("recipe suggestion engine leave-one-out benchmark", () => {
  it("exports canonical formats and retains Arabic source phrases without translating them", () => {
    expect(CANONICAL_PRODUCT_FORMATS).toContain("Wooden Heart");
    const extracted = extractProductStructure({
      name: "باقة ورد أحمر 12",
      description: "طول الساق 600 ملم",
    });
    expect(extracted.productFormat).toMatchObject({ value: "Hand Bouquet", language: "ar", sourcePhrases: ["باقة"] });
    expect(extracted.color).toMatchObject({ value: "أحمر", language: "ar" });
    expect(extracted.dimensions[0]).toMatchObject({ unit: "mm", centimeters: 60, sourcePhrase: "600 ملم" });
  });

  it("classifies singular/plural bouquets and keeps conflicting formats uncertain", () => {
    expect(extractProductStructure({ name: "Rose Bouquet" }).productFormat.value).toBe("Hand Bouquet");
    expect(extractProductStructure({ name: "Rose Bouquets" }).productFormat.value).toBe("Hand Bouquet");
    const extracted = extractProductStructure({ name: "Flower Box Vase" });
    expect(extracted.productFormat.value).toBe("Unknown");
    expect(extracted.conflicts).toEqual(expect.arrayContaining([
      expect.stringContaining("Equal-strength incompatible product formats"),
    ]));
  });

  it("resolves semantic source-aware format evidence without treating marketing prose as structure", () => {
    const resolved = resolveProductFormat({
      name: "100 Rose Majesty Bouquet",
      description: "A hand-tied floral composition. Delivered in a beautiful gift box.",
      category: "Flower Box",
      tags: ["vase"],
    });
    expect(resolved.authoritativePrimaryFormat).toBe("Hand Bouquet");
    expect(resolved.contextualRuleFormatEligible).toBe(true);
    expect(resolved.disagreements).toEqual(expect.arrayContaining([
      expect.objectContaining({ conflicting: "Flower Box", sourceField: "category", strength: "weak" }),
    ]));
    expect(resolved.observations.some(({ phrase }) => phrase === "gift box")).toBe(false);
  });

  it("keeps Bundle as wrapper context and qualifies generic boxes only as floral carriers", () => {
    const bundle = resolveProductFormat({
      name: "Heart Fever Bundle",
      description: "Bundle includes:\n• Black rectangular box 40 cm length containing 20 red roses\n• 1 balloon",
      descriptionAr: "تتضمن الباقة:\n• صندوق مستطيل 40 سم يحتوي على ورود\n• بالون",
    });
    expect(bundle.wrapperFormats).toContain("Bundle");
    expect(bundle.authoritativePrimaryFormat).toBe("Flower Box");
    expect(bundle.observations.find(({ canonicalFormat }) => canonicalFormat === "Balloon Product")?.semanticRole)
      .toBe("contained_component");
    expect(extractProductStructure({
      name: "Heart Fever Bundle",
      description: "Bundle includes:\n• Black rectangular box 40 cm length containing 20 red roses\n• 1 balloon",
    }).conflicts).toEqual([]);
    expect(resolveProductFormat({
      name: "Luxury Roses",
      description: "Includes 20 roses and a separate gift box for chocolates.",
    }).authoritativePrimaryFormat).toBeNull();
    expect(resolveProductFormat({
      name: "Luxury Roses",
      description: "Package includes:\n• 20 Red Roses\n• Premium presentation box, 40 cm",
    }).authoritativePrimaryFormat).toBeNull();
  });

  it("does not authorize primary formats from themed or figurative description bullets", () => {
    for (const description of [
      "Gift includes:\n• Vase-inspired gift",
      "Gift includes:\n• Bouquet of chocolates",
      "Gift includes:\n• Balloon-themed card, 20 cm",
      "هدية أنيقة مستوحاة من عالم البالونات",
    ]) {
      const resolved = resolveProductFormat({ name: "Celebration Gift", description });
      expect(resolved.authoritativePrimaryFormat, description).toBeNull();
      expect(resolved.contextualRuleFormatEligible, description).toBe(false);
    }
  });

  it("does not authorize Flower Box rules from delivery or presentation packaging prose", () => {
    for (const description of [
      "Delivered in a luxury Flower Box.",
      "Presented in elegant Flower Box packaging.",
      "Comes in a Flower Box gift package.",
    ]) {
      expect(resolveProductFormat({
        name: "20 Red Roses Arrangement",
        description,
      })).toMatchObject({
        authoritativePrimaryFormat: null,
        contextualRuleFormatEligible: false,
      });
    }

    const suggestion = generateRecipeSuggestion(
      generationTarget({
        name: "20 Red Roses Arrangement",
        description: "Delivered in a luxury Flower Box for elegant presentation.",
      }),
      [],
      [
        { baseItemId: 81, baseItemName: "Red Rose 40cm", quantity: 1 },
        { baseItemId: 82, baseItemName: "Red Rose 60cm", quantity: 1 },
      ],
      undefined,
      undefined,
      [{
        ruleKey: "red-rose-flower-box-40cm",
        resolverBaseItemId: 81,
        canonicalFormats: ["Flower Box"],
        ingredientFamily: "rose",
        color: "red",
        stemLengthCm: 40,
      }],
    );

    expect(suggestion.lines).toEqual([]);
    expect(suggestion.contextualRuleDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleKey: "red-rose-flower-box-40cm",
        outcome: "rejected",
        reason: expect.stringContaining("not authoritatively resolved"),
      }),
    ]));
  });

  it("does not let marketing format words change Similar-Recipe product type", () => {
    expect(productType({ name: "Bouquet of emotions", description: null, category: "Gifts" })).toBe("other");
    expect(productType({ name: "Boxed elegance", description: null, category: "Gifts" })).toBe("other");
    expect(productType({ name: "Basket of joy", description: null, category: "Gifts" })).toBe("other");
  });

  it("qualifies ambiguous Arabic bouquet wording by reusable floral context", () => {
    expect(resolveProductFormat({ name: "باقة ورد حمراء" }).authoritativePrimaryFormat).toBe("Hand Bouquet");
    const generic = resolveProductFormat({
      name: "Summer Fever Bundle",
      descriptionAr: "تتضمن الباقة هدية مميزة",
    });
    expect(generic.authoritativePrimaryFormat).toBeNull();
    expect(generic.wrapperFormats).toContain("Bundle");
  });

  it("ignores candidate metadata and authorizes only governed approved Product-format metadata", () => {
    expect(resolveProductFormat({
      name: "Roses",
      metadata: { candidateProductFormat: "Flower Box" },
    })).toMatchObject({ resolvedPrimaryFormat: null, authoritativePrimaryFormat: null, contextualRuleFormatEligible: false });
    expect(resolveProductFormat({
      name: "Roses",
      metadata: { productFormat: "Flower Box", status: "approved" },
    })).toMatchObject({ resolvedPrimaryFormat: "Flower Box", authoritativePrimaryFormat: "Flower Box", contextualRuleFormatEligible: true });
  });

  it("deduplicates format resolution while retaining every supporting observation", () => {
    const resolved = resolveProductFormat({
      name: "20 Red Roses Bouquet",
      description: "Bouquet includes:\n• 20 Red Roses\n• Hand-tied bouquet construction",
    });
    const handBouquet = resolved.deduplicatedResolutionEvidence.find(
      ({ canonicalFormat }) => canonicalFormat === "Hand Bouquet",
    );
    expect(handBouquet?.supportingObservations.map(({ sourceField }) => sourceField)).toEqual(
      expect.arrayContaining(["name", "description"]),
    );
  });

  it("locks the four reviewed historical format outcomes and contextual red-rose variants", () => {
    const cases = [
      {
        id: 337,
        name: "100 Rose Majesty Bouquet",
        description: "Bouquet includes:\n• 100 Red Roses",
        category: "Flower Boxes",
        expectedFormat: "Hand Bouquet",
        expectedBaseItemId: 82,
        wrapper: null,
        disagreement: "Flower Box",
      },
      {
        id: 395,
        name: "Summer Fever Box",
        description: "Flower box includes:\n• 5 Red Roses\n• Flower Box 40 cm Length × 17 cm Width × 20 cm Height",
        category: "Flower Vases",
        expectedFormat: "Flower Box",
        expectedBaseItemId: 81,
        wrapper: null,
        disagreement: "Vase Arrangement",
      },
      {
        id: 412,
        name: "Summer Fever Bundle",
        description: "Bundle includes:\n• 5 Red Roses\n• Flower Box 40 cm Length × 17 cm Width × 20 cm Height",
        category: "Flowers",
        expectedFormat: "Flower Box",
        expectedBaseItemId: 81,
        wrapper: "Bundle",
        disagreement: null,
      },
      {
        id: 449,
        name: "Heart Fever Bundle",
        description: "Bundle includes:\n• 12 Red Roses\n• Black Rectangular Box 40 cm Length × 17 cm Width × 20 cm Height",
        descriptionAr: "تتضمن الباقة:\n• 12 وردة حمراء\n• صندوق مستطيل أسود، طول 40 سم × عرض 17 سم × ارتفاع 20 سم",
        category: "Bundles",
        expectedFormat: "Flower Box",
        expectedBaseItemId: 81,
        wrapper: "Bundle",
        disagreement: null,
      },
    ] as const;
    const variants: RecipeLineInput[] = [
      { baseItemId: 81, baseItemName: "Red Rose 40cm", quantity: 1 },
      { baseItemId: 82, baseItemName: "Red Rose 60cm", quantity: 1 },
    ];
    const rules = [
      {
        ruleKey: "flower-box",
        resolverBaseItemId: 81,
        canonicalFormats: ["Flower Box"] as const,
        ingredientFamily: "rose",
        color: "red",
        stemLengthCm: 40,
      },
      {
        ruleKey: "hand-bouquet",
        resolverBaseItemId: 82,
        canonicalFormats: ["Hand Bouquet"] as const,
        ingredientFamily: "rose",
        color: "red",
        stemLengthCm: 60,
      },
    ];
    for (const reviewed of cases) {
      const resolved = resolveProductFormat(reviewed);
      const structure = extractProductStructure(reviewed);
      expect(resolved.authoritativePrimaryFormat, `Product #${reviewed.id}`).toBe(reviewed.expectedFormat);
      expect(resolved.wrapperFormats.includes("Bundle"), `Product #${reviewed.id}`).toBe(reviewed.wrapper === "Bundle");
      expect(resolved.disagreements.map(({ conflicting }) => conflicting), `Product #${reviewed.id}`)
        .toEqual(reviewed.disagreement ? expect.arrayContaining([reviewed.disagreement]) : []);
      if (reviewed.id === 412 || reviewed.id === 449) {
        expect(structure.productFormat.sourcePhrases).not.toContain("Bundle");
        expect(structure.container.sourcePhrases).not.toContain("Bundle");
        expect(structure.container.sourcePhrases.some((phrase) => /box|صندوق/i.test(phrase))).toBe(true);
      }
      const suggestion = generateRecipeSuggestion(
        generationTarget(reviewed),
        [],
        variants,
        undefined,
        undefined,
        rules.map((rule) => ({ ...rule, canonicalFormats: [...rule.canonicalFormats] })),
      );
      expect(suggestion.lines.find(({ contextualRuleProvenance }) => contextualRuleProvenance)?.baseItemId)
        .toBe(reviewed.expectedBaseItemId);
    }
  });

  it("separates stable configuration and Product-specific case fingerprints", () => {
    const configuration = {
      baseItems: [{ baseItemId: 1, baseItemName: "Red Rose", quantity: 1 }],
      operationalRules: { flowerBoxSponge: false, balloonMetalRing: false },
      contextualRules: [],
      boundedAi: { policyVersion: "bounded-v1", model: "model", enabled: true },
    };
    const first = runProductionRecipeMatcher(generationTarget({ id: 700, name: "Red Rose Bouquet" }), [], configuration);
    const second = runProductionRecipeMatcher(generationTarget({ id: 701, name: "Red Rose Bouquet" }), [], configuration);
    expect(first.configurationFingerprint).toBe(second.configurationFingerprint);
    expect(first.caseInputFingerprint).not.toBe(second.caseInputFingerprint);
    expect(runProductionRecipeMatcher(generationTarget({ id: 700, name: "Red Rose Bouquet" }), [], {
      ...configuration,
      baseItems: [...configuration.baseItems].reverse(),
    }).configurationFingerprint).toBe(first.configurationFingerprint);
    expect(runProductionRecipeMatcher(generationTarget({
      id: 700,
      name: "Red Rose Bouquet",
      metadata: { candidateProductFormat: "Flower Box", rejectedFormat: "Vase Arrangement" },
    }), [], {
      ...configuration,
      baseItems: [{
        ...configuration.baseItems[0],
        metadata: { candidateColor: "blue", rejectedStemLength: 50 },
      }],
    })).toMatchObject({
      configurationFingerprint: first.configurationFingerprint,
      caseInputFingerprint: first.caseInputFingerprint,
    });
  });

  it("normalizes dimensions but does not use images as identity, quantity, or dimension evidence", () => {
    const extracted = extractProductStructure({ name: "Gift 2.5m", description: "4 x 6in" });
    expect(extracted.dimensions.map((dimension) => dimension.centimeters)).toEqual([250, 15.24]);
    const suggestion = generateRecipeSuggestion(
      generationTarget({
        id: 499,
        name: "Red Rose Flower Box",
        metadata: { imageEvidence: { ingredient: "Red Rose", quantity: 99, stemLength: "40cm" } },
      }),
      [],
      [{ baseItemId: 90, baseItemName: "Red Rose 40cm", quantity: 1, metadata: { imageEvidence: true } }],
    );
    expect(suggestion.lines).toEqual([
      expect.objectContaining({ baseItemId: 90, quantity: 1, requirementId: expect.stringMatching(/^req_/) }),
    ]);
  });

  it("blocks format-specific resolution when the product declares conflicting formats", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 500, name: "20 Red Roses Flower Box Vase" }),
      [],
      [
        { baseItemId: 81, baseItemName: "Red Rose 40cm", quantity: 1 },
        { baseItemId: 82, baseItemName: "Red Rose 60cm", quantity: 1 },
      ],
      undefined,
      undefined,
      [
        {
          resolverBaseItemId: 81,
          canonicalFormats: ["Flower Box"],
          ingredientFamily: "rose",
          color: "red",
          stemLengthCm: 40,
        },
        {
          resolverBaseItemId: 82,
          canonicalFormats: ["Hand Bouquet"],
          ingredientFamily: "rose",
          color: "red",
          stemLengthCm: 60,
        },
      ],
    );
    expect(suggestion.structure.conflicts).not.toEqual([]);
    expect(suggestion.lines).toEqual([]);
    expect(suggestion.unresolvedRequirements[0].candidateBaseItemIds).toEqual([81, 82]);
  });

  it("matches approved Arabic aliases without translating catalog text", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 501, name: "باقة توليب" }),
      [],
      [{
        baseItemId: 91,
        baseItemName: "Tulip",
        quantity: 1,
        metadata: { approvedAliases: ["توليب"] },
      }],
    );
    expect(suggestion.lines).toEqual([expect.objectContaining({ baseItemId: 91 })]);
  });

  it("keeps the frozen v2 benchmark isolated from contextual format resolution", () => {
    const target = generationTarget({ id: 502, name: "20 Red Roses Flower Box" });
    const variants: RecipeLineInput[] = [
      { baseItemId: 81, baseItemName: "Red Rose 40cm", quantity: 1 },
      { baseItemId: 82, baseItemName: "Red Rose 60cm", quantity: 1 },
    ];
    expect(generateRecipeSuggestion(target, [], variants, undefined, undefined, [{
      resolverBaseItemId: 81,
      canonicalFormats: ["Flower Box"],
      ingredientFamily: "rose",
      color: "red",
      stemLengthCm: 40,
    }]).lines).toEqual([
      expect.objectContaining({ baseItemId: 81 }),
    ]);
    expect(generateFrozenPreChangeRecipeSuggestion(target, [], variants).lines).toEqual([]);
  });

  it.each([
    ["Flower Box", 40],
    ["Wooden Letter", 40],
    ["Wooden Heart", 40],
    ["Hand Bouquet", 60],
  ])("uses a uniquely confirmed red rose length for %s", (format, length) => {
    const roses: RecipeLineInput[] = [
      { baseItemId: 81, baseItemName: "Red Rose 40cm", quantity: 1, metadata: { confirmed: true } },
      { baseItemId: 82, baseItemName: "Red Rose 60cm", quantity: 1, metadata: { approved: true } },
    ];
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 480 + length, name: `20 Red Roses ${format}` }),
      [],
      roses,
      undefined,
      undefined,
      [{
        resolverBaseItemId: length === 40 ? 81 : 82,
        canonicalFormats: [format as "Flower Box" | "Wooden Letter" | "Wooden Heart" | "Hand Bouquet"],
        ingredientFamily: "rose",
        color: "red",
        stemLengthCm: length,
      }],
    );
    expect(suggestion.lines).toEqual([expect.objectContaining({ baseItemId: length === 40 ? 81 : 82, quantity: 20 })]);
  });

  it("attributes an applied contextual decision to the exact rule when resolvers are shared", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 520, name: "20 Red Roses Flower Box" }),
      [],
      [
        { baseItemId: 81, baseItemName: "Red Rose 40cm", quantity: 1 },
        { baseItemId: 82, baseItemName: "Red Rose 60cm", quantity: 1 },
      ],
      undefined,
      undefined,
      [
        {
          ruleId: 1,
          ruleKey: "flower-box",
          resolverBaseItemId: 81,
          canonicalFormats: ["Flower Box"],
          ingredientFamily: "rose",
          color: "red",
          stemLengthCm: 40,
        },
        {
          ruleId: 2,
          ruleKey: "wooden-heart",
          resolverBaseItemId: 81,
          canonicalFormats: ["Wooden Heart"],
          ingredientFamily: "rose",
          color: "red",
          stemLengthCm: 40,
        },
      ],
    );
    expect(suggestion.contextualRuleDiagnostics?.filter(({ outcome }) => outcome === "applied")).toEqual([
      expect.objectContaining({
        ruleKey: "flower-box",
        authoritativePrimaryFormat: "Flower Box",
        independentlyVerifiedGovernedValue: 40,
      }),
    ]);
    expect(suggestion.contextualRuleDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleKey: "wooden-heart", outcome: "rejected" }),
    ]));
  });

  it("does not default 50cm or resolve incomplete and multiple dimensional variants", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 490, name: "20 Red Roses Flower Box" }),
      [],
      [
        { baseItemId: 83, baseItemName: "Red Rose 50cm", quantity: 1, metadata: { confirmed: true } },
        { baseItemId: 84, baseItemName: "40cm Red Rose", quantity: 1, metadata: { confirmed: true } },
        { baseItemId: 85, baseItemName: "Red Rose 40cm 60cm", quantity: 1, metadata: { confirmed: true } },
      ],
    );
    expect(suggestion.lines).toEqual([]);
    expect(suggestion.unresolvedRequirements[0].quantity).toBe(20);
  });

  it("keeps the hidden flower-box sponge rule additive", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 494, name: "Medium Round Flower Box with 30 Red Roses" }),
      [],
      baseItems,
    );

    expect(suggestion.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        baseItemId: 3,
        quantity: 1,
        hiddenRuleKey: "flower_box_round_medium_sponge",
      }),
    ]));
  });

  it("keeps the hidden balloon metal-ring rule additive with one ring per physical balloon", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 495, name: "3 Latex Balloons" }),
      [],
      baseItems,
    );

    expect(suggestion.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ baseItemId: 5, quantity: 3 }),
      expect.objectContaining({
        baseItemId: 4,
        quantity: 3,
        hiddenRuleKey: "balloon_metal_ring",
      }),
    ]));
  });

  it("filters similar-recipe evidence to active candidate ids", () => {
    const support = product({
      id: 491,
      name: "Pink Bouquet",
      recipes: [{ baseItemId: 99, baseItemName: "Pink Rose", quantity: 5 }],
    });
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 492, name: "Pink Bouquet", activeCandidateIds: [98] }),
      [support, product({ id: 493, name: "Pink Bouquet", recipes: [{ baseItemId: 99, baseItemName: "Pink Rose", quantity: 5 }] })],
      [],
    );
    expect(suggestion.lines).toEqual([]);
  });

  it("ranks a complete plural-aware ingredient phrase above generic and related items", () => {
    const orangeItems: RecipeLineInput[] = [
      { baseItemId: 21, baseItemName: "Orange", baseItemCode: "COLOR-ORANGE", quantity: 1 },
      { baseItemId: 22, baseItemName: "Orange Rose", baseItemCode: "ROSE-ORANGE", quantity: 1 },
      { baseItemId: 23, baseItemName: "Orange Ranunculus", baseItemCode: "RAN-ORANGE", quantity: 1 },
      { baseItemId: 24, baseItemName: "Dried Orange Ruscus", baseItemCode: "RUSCUS-DRIED", quantity: 1 },
    ];

    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 500, name: "25 Orange Roses Arrangement", description: null }),
      [],
      orangeItems,
    );

    expect(suggestion.lines).toEqual([
      expect.objectContaining({
        baseItemId: 22,
        quantity: 25,
        confidence: "high",
        unresolved: false,
      }),
    ]);
    expect(suggestion.unresolvedLines).toEqual([]);
  });

  it("keeps unstated stem-length variants unresolved and preserves the extracted quantity", () => {
    const orangeItems: RecipeLineInput[] = [
      { baseItemId: 31, baseItemName: "Orange", baseItemCode: "COLOR-ORANGE", quantity: 1 },
      { baseItemId: 32, baseItemName: "Orange Rose 40cm", baseItemCode: "ROSE-ORANGE-40", quantity: 1 },
      { baseItemId: 33, baseItemName: "Orange Rose 60cm", baseItemCode: "ROSE-ORANGE-60", quantity: 1 },
      { baseItemId: 34, baseItemName: "Orange Ranunculus", baseItemCode: "RAN-ORANGE", quantity: 1 },
      { baseItemId: 35, baseItemName: "Dried Orange Ruscus", baseItemCode: "RUSCUS-DRIED", quantity: 1 },
    ];

    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 501, name: "25 Orange Roses Arrangement", description: null }),
      [],
      orangeItems,
    );

    expect(suggestion.lines).toEqual([]);
    expect(suggestion.unresolvedRequirements).toEqual([
      expect.objectContaining({
        quantity: 25,
        candidateBaseItemIds: [32, 33],
        reason: expect.stringContaining("multiple credible Base Item candidates"),
      }),
    ]);
    expect(suggestion.unresolvedLines[0]).toContain("ambiguous Base Item variant");
  });

  it("does not promote a color-only Base Item when the ingredient is more specific", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 503, name: "25 Orange Roses Arrangement", description: null }),
      [],
      [{ baseItemId: 41, baseItemName: "Orange", baseItemCode: "ORANGE", quantity: 1 }],
    );

    expect(suggestion.lines).toEqual([]);
    expect(suggestion.unresolvedRequirements).toEqual([
      expect.objectContaining({
        quantity: 25,
        candidateBaseItemIds: undefined,
        reason: expect.stringContaining("no credible existing Base Item"),
      }),
    ]);
  });

  it("requires ingredient tokens to form an ordered phrase", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({
        id: 504,
        name: "Red Celebration Box",
        description: "Includes a rose-gold ribbon",
        category: "Flowers",
      }),
      [],
      [{ baseItemId: 42, baseItemName: "Red Rose", baseItemCode: "FLOWER-RR", quantity: 1 }],
    );

    expect(suggestion.lines).toEqual([]);
    expect(suggestion.requirements.every((requirement) => !requirement.phrase.toLowerCase().includes("ribbon"))).toBe(true);
  });

  it("normalizes a non-rose singular and plural consistently", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 505, name: "8 Purple Irises Bouquet", description: null }),
      [],
      [{ baseItemId: 43, baseItemName: "Purple Iris", baseItemCode: "IRIS-PURPLE", quantity: 1 }],
    );

    expect(suggestion.lines).toEqual([
      expect.objectContaining({ baseItemId: 43, quantity: 8, confidence: "high" }),
    ]);
    expect(suggestion.unresolvedLines).toEqual([]);
  });

  it.each([
    "12 stems of Red Roses",
    "12 bunches Red Roses",
    "12 pieces of Red Roses",
  ])("extracts quantity through unit filler in %s", (name) => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 506, name, description: null }),
      [],
      baseItems,
    );

    expect(suggestion.lines.find((line) => line.baseItemId === 1)).toMatchObject({
      quantity: 12,
      confidence: "high",
    });
  });

  it("does not treat a shorter Base Item code as an exact reference to a longer variant code", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 507, name: "Custom design ROSE-RED-40", description: null }),
      [],
      baseItems,
    );

    expect(suggestion.lines).toEqual([]);
    expect(suggestion.unresolvedRequirements[0]).toMatchObject({
      candidateBaseItemIds: undefined,
      reason: expect.stringContaining("no credible existing Base Item"),
    });
  });

  it("retains exact Base Item code matching", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 502, name: "Custom design ROSE-RED", description: null }),
      [],
      baseItems,
    );

    expect(suggestion.lines).toEqual([
      expect.objectContaining({
        baseItemId: 1,
        quantity: 1,
        confidence: "high",
        reason: expect.stringContaining("catalog_reference"),
      }),
    ]);
    expect(suggestion.unresolvedLines).toEqual([]);
  });

  it("uses hard rules and never needs the target approved recipe as engine input", () => {
    const target = product();
    const approvedRecipe = [
      { ...baseItems[0], quantity: 20 },
      { ...baseItems[1], quantity: 1 },
      { ...baseItems[2], quantity: 1 },
    ];
    const similarlyApproved = product({
      id: 101,
      name: "Medium Round Flower Box with White Roses",
      recipes: [
        { ...baseItems[1], quantity: 1 },
        { ...baseItems[2], quantity: 1 },
      ],
    });

    // target.recipes intentionally remains empty: the target approved recipe is
    // comparison-only data, not supporting evidence for generation.
    const { recipes: _targetRecipe, ...generationTarget } = target;
    const suggestion = generateRecipeSuggestion(generationTarget, [similarlyApproved], baseItems);
    const comparison = compareRecipeSuggestion(suggestion, approvedRecipe, target);

    expect(suggestion.leaveOneOut).toMatchObject({
      directRecipeWithheld: true,
      excludedProductId: 100,
      supportingProductIds: [101],
    });
    expect(suggestion.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ baseItemId: 1, quantity: 20 }),
        expect.objectContaining({ baseItemId: 3, quantity: 1, hiddenRuleKey: expect.stringContaining("flower_box") }),
      ]),
    );
    expect(comparison.baseItem.recall).toBeGreaterThan(0);
    expect(comparison.hiddenRule.expectedCount).toBe(2);
  });

  it("flags conflicting similar recipe quantities instead of silently choosing evidence", () => {
    const target = product({ id: 200, name: "Pink Bouquet" });
    const supportA = product({
      id: 201,
      name: "Pink Bouquet",
      recipes: [{ ...baseItems[0], quantity: 12 }],
    });
    const supportB = product({
      id: 202,
      name: "Pink Bouquet Deluxe",
      recipes: [{ ...baseItems[0], quantity: 24 }],
    });

    const { recipes: _targetRecipe, ...generationTarget } = target;
    const suggestion = generateRecipeSuggestion(generationTarget, [supportA, supportB], baseItems);

    expect(suggestion.conflicts).toEqual([
      expect.objectContaining({
        baseItemId: 1,
        quantities: [12, 24],
        supportingProductIds: [201, 202],
      }),
    ]);
    expect(suggestion.lines.find((line) => line.baseItemId === 1)).toBeUndefined();
  });

  it("extracts stable semantic requirements and rejects lexical fragments", () => {
    const target = {
      name: "Bundle: 12 Red Roses, 2 Latex Balloons, Wrapping Paper and Chocolate Gift",
      description: "Small mix in glass, 20cm. Finished with elegant ribbon styling.",
    };
    const first = extractRecipeRequirements(target);
    const second = extractRecipeRequirements(target);
    expect(first.map((requirement) => requirement.requirementId)).toEqual(
      second.map((requirement) => requirement.requirementId),
    );
    expect(first.map((requirement) => requirement.subtype)).toEqual(
      expect.arrayContaining(["botanical", "balloon", "wrapping_paper", "gift"]),
    );
    expect(first.map((requirement) => requirement.phrase.toLowerCase())).not.toEqual(
      expect.arrayContaining(["of", "in", "small", "mix", "glass", "20cm", "ribbon"]),
    );
  });

  it("covers the established Presentail botanical families and preserves modifiers, quantities, and units", () => {
    const requirements = extractRecipeRequirements({
      name: "Catalog Botanical Composition",
      description: [
        "Arrangement includes:",
        "• 20 Pink Carnations",
        "• 3 White Chrysanthemums",
        "• 4 Orange Gerberas",
        "• 5 Stems Yellow Lilies",
        "• 2 Calla Lilies",
        "• 1 Green Hypericum",
        "• 2 White Gypsophila",
        "• 3 Pink Dahlias",
        "• 2 Stems Pink Matthiola",
        "• 5 White Eustoma",
        "• 2 Stems Red Dried Limonium",
        "• 2 Yellow Solidago",
        "• 4 Sunflowers",
        "• 5 Stems White Spray Roses",
        "• 4 Stems Orange Baby Roses",
        "• 2 Blue Hydrangeas",
        "• 1 Red Anthurium",
        "• 3 Stems Purple Delphinium",
        "• 2 Pink Celosia",
        "• 2 Purple Statice",
      ].join("\n"),
    });
    expect(requirements.map(({ phrase, quantity, unit }) => ({ phrase, quantity, unit }))).toEqual([
      { phrase: "Pink Carnations", quantity: 20, unit: null },
      { phrase: "White Chrysanthemums", quantity: 3, unit: null },
      { phrase: "Orange Gerberas", quantity: 4, unit: null },
      { phrase: "Yellow Lilies", quantity: 5, unit: "Stems" },
      { phrase: "Calla Lilies", quantity: 2, unit: null },
      { phrase: "Green Hypericum", quantity: 1, unit: null },
      { phrase: "White Gypsophila", quantity: 2, unit: null },
      { phrase: "Pink Dahlias", quantity: 3, unit: null },
      { phrase: "Pink Matthiola", quantity: 2, unit: "Stems" },
      { phrase: "White Eustoma", quantity: 5, unit: null },
      { phrase: "Red Dried Limonium", quantity: 2, unit: "Stems" },
      { phrase: "Yellow Solidago", quantity: 2, unit: null },
      { phrase: "Sunflowers", quantity: 4, unit: null },
      { phrase: "White Spray Roses", quantity: 5, unit: "Stems" },
      { phrase: "Orange Baby Roses", quantity: 4, unit: "Stems" },
      { phrase: "Blue Hydrangeas", quantity: 2, unit: null },
      { phrase: "Red Anthurium", quantity: 1, unit: null },
      { phrase: "Purple Delphinium", quantity: 3, unit: "Stems" },
      { phrase: "Pink Celosia", quantity: 2, unit: null },
      { phrase: "Purple Statice", quantity: 2, unit: null },
    ]);
  });

  it("recognizes the additional catalog-verified botanical families without admitting arbitrary marketing nouns", () => {
    const requirements = extractRecipeRequirements({
      name: "Verified Botanical Composition",
      description: [
        "Arrangement includes:",
        "• 2 English Roses",
        "• 3 Hawthorn Berries",
        "• 4 Copper Beech Leaves",
        "• 2 Dendrobiums",
        "• 5 Burnet Flowers",
        "• 3 Oak Leaves",
        "• 4 Astilbes",
        "• 6 Carthamus",
        "A velvet dream celebrates timeless affection.",
      ].join("\n"),
    });
    expect(requirements.map(({ phrase, quantity }) => [phrase, quantity])).toEqual([
      ["English Roses", 2],
      ["Hawthorn Berries", 3],
      ["Copper Beech Leaves", 4],
      ["Dendrobiums", 2],
      ["Burnet Flowers", 5],
      ["Oak Leaves", 3],
      ["Astilbes", 4],
      ["Carthamus", 6],
    ]);
  });

  it("retains explicit care products and white paper independently of Base Item availability", () => {
    const midnight = generateRecipeSuggestion(
      generationTarget({
        id: 241,
        name: "Midnight Essence Basket",
        description: [
          "Basket includes:",
          "• Lavender and Olive Oil Shampoo",
          "• Lavender and Olive Oil Shower Gel",
          "• Lavender and Olive Oil Conditioner",
          "• Rose and Oud Body Mist",
          "• Rose and Oud Soap Bar",
        ].join("\n"),
      }),
      [],
      [],
    );
    expect(midnight.requirements.filter(({ subtype }) => subtype === "product").map(({ phrase, resolution }) => [phrase, resolution])).toEqual([
      ["Lavender and Olive Oil Shampoo", "no_match"],
      ["Lavender and Olive Oil Shower Gel", "no_match"],
      ["Lavender and Olive Oil Conditioner", "no_match"],
      ["Rose and Oud Body Mist", "no_match"],
      ["Rose and Oud Soap Bar", "no_match"],
    ]);

    const wrapped = extractRecipeRequirements({
      name: "Bundle of 30 Pink Roses",
      description: "30 Pink Roses wrapped in elegant white paper",
    });
    expect(wrapped).toEqual(expect.arrayContaining([
      expect.objectContaining({ subtype: "botanical", quantity: 30 }),
      expect.objectContaining({ subtype: "wrapping_paper", phrase: "elegant white paper", resolution: "no_match" }),
    ]));
    expect(extractRecipeRequirements({
      name: "Celebration Balloon",
      description: "Celebration foil balloon, 18 inch helium-filled",
    }).filter(({ subtype }) => subtype === "balloon")).toEqual([
      expect.objectContaining({ attributes: expect.objectContaining({ fill: "helium" }) }),
    ]);
    expect(extractRecipeRequirements({
      name: "Great Dad Celebration Balloon",
      description: "Great Dad Celebration Balloon, 18 inch helium-filled foil balloon",
    }).filter(({ subtype }) => subtype === "balloon")).toHaveLength(1);
  });

  it.each([
    [
      "Glass vase (20 cm height, 10 cm diameter)",
      { height: 20, diameter: 10 },
    ],
    [
      "Basket 40 cm Height × 30 cm Diameter × 12 cm Depth",
      { height: 40, diameter: 30, depth: 12 },
    ],
    [
      "White Heart-Shaped Box 12 cm Height × 25 cm Diameter",
      { height: 12, diameter: 25 },
    ],
    [
      "Black Rectangular Flower Box 40 cm Length × 17 cm Width × 20 cm Height",
      { length: 40, width: 17, height: 20 },
    ],
  ] as const)("preserves labeled dimensions from the full component span: %s", (component, expected) => {
    const requirement = extractRecipeRequirements({
      name: "Measured Composition",
      description: `Arrangement includes:\n• ${component}`,
    }).find(({ subtype }) => subtype === "container")!;
    expect(requirement.evidence.semanticSpan!.end).toBeGreaterThan(requirement.evidence.span.end);
    for (const [label, centimeters] of Object.entries(expected)) {
      expect(requirement.attributes[label]).toMatchObject({ centimeters, unit: "cm" });
    }
  });

  it("preserves explicit flower stem length from the component clause", () => {
    const requirement = extractRecipeRequirements({
      name: "Long Stem Bouquet",
      description: "Bouquet includes:\n• 12 Red Roses, stem length 60 cm",
    }).find(({ subtype }) => subtype === "botanical")!;
    expect(requirement.attributes.stemLength).toMatchObject({ centimeters: 60, unit: "cm" });
  });

  it("merges compatible bilingual duplicates with both evidence records but preserves color conflicts", () => {
    const matching = extractRecipeRequirements({
      name: "Bilingual Roses",
      description: "Bouquet includes:\n• 5 Red Roses",
      descriptionAr: "تتضمن الباقة:\n• 5 ورود حمراء",
    }).filter(({ subtype }) => subtype === "botanical");
    expect(matching).toHaveLength(1);
    expect(matching[0].additionalEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceField: "descriptionAr" }),
    ]));

    const conflicting = extractRecipeRequirements({
      name: "Bilingual Roses",
      description: "Bouquet includes:\n• 5 Red Roses",
      descriptionAr: "تتضمن الباقة:\n• 5 ورود بيضاء",
    }).filter(({ subtype }) => subtype === "botanical");
    expect(conflicting).toHaveLength(2);
    expect(conflicting.map(({ attributes }) => attributes.color)).toEqual(expect.arrayContaining(["Red", "بيضاء"]));
  });

  it.each([
    [
      "Sweetheart Roses",
      "Bouquet includes:\n• 20 red carnations\n• 20 pink carnations\n• Black wrapping paper",
      [["red carnations", 20], ["pink carnations", 20], ["black wrapping paper", 1]],
    ],
    [
      "Garden Mix",
      "Arrangement includes:\n• 4 red roses\n• 2 stems pink dahlias\n• 5 stems pink chrysanthemums\n• Glass vase (20 cm height, 10 cm diameter)",
      [["red roses", 4], ["pink dahlias", 2], ["pink chrysanthemums", 5], ["glass vase", 1]],
    ],
    [
      "Scarlet Bouquet",
      "Bouquet includes:\n• 6 red roses\n• 3 red lilies\n• 4 red gerberas\n• 3 hypericum\n• 2 stems white gypsophila\n• 3 stems red chrysanthemums\n• Black wrapping paper",
      [["red roses", 6], ["red lilies", 3], ["red gerberas", 4], ["hypericum", 3], ["white gypsophila", 2], ["red chrysanthemums", 3], ["black wrapping paper", 1]],
    ],
    [
      "Bloom Éclat Basket",
      "Basket includes:\n• 3 Stems Pink Matthiola\n• 10 Sweet Pink Roses\n• 2 Stems Sweet Pink Spray Roses\n• 2 Stems White Eustoma\n• Basket 40 cm Height × 30 cm Diameter",
      [["pink matthiola", 3], ["sweet pink roses", 10], ["sweet pink spray roses", 2], ["white eustoma", 2], ["basket", 1]],
    ],
    [
      "Summer Fever Box",
      "Flower box includes:\n• 10 Cherry Brandy Roses\n• 5 Red Roses\n• 5 Peach Roses\n• 4 Orange Gerberas\n• 4 Sunflowers\n• 4 Stems Orange Baby Roses\n• 2 Stems Red Dried Limonium\n• 2 Stems Eucalyptus\n• Flower Box 40 cm Length × 17 cm Width × 20 cm Height",
      [["cherry brandy roses", 10], ["red roses", 5], ["peach roses", 5], ["orange gerberas", 4], ["sunflowers", 4], ["orange baby roses", 4], ["red dried limonium", 2], ["eucalyptus", 2], ["flower box", 1]],
    ],
  ] as const)("extracts real cohort-style composition for %s", (name, description, expected) => {
    const requirements = extractRecipeRequirements({ name, description });
    const actual = requirements.map(({ phrase, quantity }) => [phrase.toLowerCase(), quantity]);
    expect(actual).toHaveLength(expected.length);
    expect(actual).toEqual(expect.arrayContaining(expected.map(([phrase, quantity]) => [phrase, quantity])));
  });

  it("reconciles descriptive cross-field balloon references without collapsing intentional list repetitions", () => {
    const bestMom = generateRecipeSuggestion(
      generationTarget({
        name: "Best Mom Ever Balloon",
        description: "Best Mom Ever foil balloon, 18 inch helium-filled",
        descriptionAr: "بالون فويل أفضل أم على الإطلاق، 18 بوصة مملوء بالهيليوم",
        category: "Balloons",
      }),
      [],
      [
        { baseItemId: 5, baseItemName: "Balloon", quantity: 1 },
        { baseItemId: 4, baseItemName: "Metal Ring", quantity: 1 },
        { baseItemId: 6, baseItemName: "Helium", quantity: 1 },
      ],
    );
    expect(bestMom.requirements.filter(({ subtype }) => subtype === "balloon")).toHaveLength(1);
    expect(bestMom.requirements.filter(({ subtype }) => subtype === "helium_fill")).toEqual([
      expect.objectContaining({
        phrase: "Helium",
        quantity: 1,
        attributes: expect.objectContaining({
          fill: "helium",
          balloonType: "foil",
          dimensionCentimeters: 45.72,
        }),
      }),
    ]);
    expect(bestMom.lines.find(({ baseItemName }) => baseItemName === "Helium")).toBeUndefined();
    expect(bestMom.unresolvedRequirements.find(({ requirementProvenance }) =>
      requirementProvenance?.subtype === "helium_fill",
    )).toMatchObject({ quantity: 1, candidateBaseItemIds: [6] });
    expect(bestMom.lines.find(({ hiddenRuleKey }) => hiddenRuleKey === "balloon_metal_ring")).toMatchObject({ quantity: 1 });

    const greatDad = extractRecipeRequirements({
      name: "Great Dad Balloon",
      description: "Great Dad foil balloon, 18 inch helium-filled",
    });
    expect(greatDad.filter(({ subtype }) => subtype === "balloon")).toHaveLength(1);
    expect(greatDad.filter(({ subtype }) => subtype === "helium_fill")).toHaveLength(1);

    expect(extractRecipeRequirements({
      name: "Celebration Bundle",
      description: "Bundle includes:\n• 1 Foil Balloon\n• 1 Foil Balloon",
    }).filter(({ subtype }) => subtype === "balloon")).toHaveLength(2);
  });

  it("creates no Helium requirement unless helium fill is explicit", () => {
    const requirements = extractRecipeRequirements({
      name: "Celebration Balloon",
      description: "2 foil balloons",
    });
    expect(requirements.filter(({ subtype }) => subtype === "balloon")).toEqual([
      expect.objectContaining({ quantity: 2 }),
    ]);
    expect(requirements.some(({ subtype }) => subtype === "helium_fill")).toBe(false);
  });

  it("binds explicit Helium and Metal Ring quantities to the physical balloon count", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({
        name: "Celebration Balloon Set",
        description: "2 helium-filled foil balloons",
      }),
      [],
      [
        { baseItemId: 5, baseItemName: "Foil Balloon", quantity: 1 },
        { baseItemId: 6, baseItemName: "Helium", quantity: 1 },
        { baseItemId: 4, baseItemName: "Metal Ring", quantity: 1 },
      ],
    );
    expect(suggestion.requirements.filter(({ subtype }) => subtype === "balloon")).toEqual([
      expect.objectContaining({ quantity: 2 }),
    ]);
    expect(suggestion.requirements.filter(({ subtype }) => subtype === "helium_fill")).toEqual([
      expect.objectContaining({ quantity: 2 }),
    ]);
    expect(suggestion.lines.find(({ baseItemId }) => baseItemId === 5)).toMatchObject({
      quantity: 2,
      requirementId: expect.stringMatching(/^req_/),
    });
    expect(suggestion.lines.find(({ baseItemId }) => baseItemId === 6)).toMatchObject({
      quantity: 2,
      requirementId: expect.stringMatching(/^req_/),
    });
    expect(suggestion.lines.find(({ hiddenRuleKey }) => hiddenRuleKey === "balloon_metal_ring")).toMatchObject({
      quantity: 2,
      requirementId: null,
    });
  });

  it.each([
    ["an ambiguous singular balloon", "Celebration foil balloon", 1],
    ["ambiguous multiple balloons", "3 foil balloons", 3],
  ])("keeps Metal Ring quantity requirement-bound for %s", (_label, description, quantity) => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({
        name: quantity === 1 ? description : "Celebration",
        description: quantity === 1 ? null : description,
      }),
      [],
      [
        { baseItemId: 5, baseItemName: "Small Foil Balloon", quantity: 1 },
        { baseItemId: 6, baseItemName: "Large Foil Balloon", quantity: 1 },
        { baseItemId: 4, baseItemName: "Metal Ring", quantity: 1 },
      ],
    );
    expect(suggestion.requirements.filter(({ subtype }) => subtype === "balloon")).toEqual([
      expect.objectContaining({ quantity, resolution: "ambiguous" }),
    ]);
    expect(suggestion.lines.some(({ baseItemName }) => baseItemName.includes("Balloon"))).toBe(false);
    expect(suggestion.lines.find(({ hiddenRuleKey }) => hiddenRuleKey === "balloon_metal_ring")).toMatchObject({
      quantity,
      requirementId: null,
    });
  });

  it("adds Metal Ring for an ambiguous singular helium-filled balloon", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({
        name: "Best Dad",
        description: "Foil balloon, 18 inch helium-filled",
      }),
      [],
      [
        { baseItemId: 5, baseItemName: "Small Foil Balloon", quantity: 1 },
        { baseItemId: 6, baseItemName: "Large Foil Balloon", quantity: 1 },
        { baseItemId: 7, baseItemName: "Helium", quantity: 1 },
        { baseItemId: 4, baseItemName: "Metal Ring", quantity: 1 },
      ],
    );
    expect(suggestion.requirements.find(({ subtype }) => subtype === "balloon")).toMatchObject({
      quantity: 1,
      resolution: "ambiguous",
    });
    expect(suggestion.lines.find(({ baseItemId }) => baseItemId === 7)).toBeUndefined();
    expect(suggestion.unresolvedRequirements.find(({ requirementProvenance }) =>
      requirementProvenance?.subtype === "helium_fill",
    )).toMatchObject({ quantity: 1, candidateBaseItemIds: [7] });
    expect(suggestion.lines.find(({ hiddenRuleKey }) => hiddenRuleKey === "balloon_metal_ring")).toMatchObject({
      quantity: 1,
      requirementId: null,
    });
  });

  it("requires composition context in descriptions and suppresses marketing-prose component nouns", () => {
    const requirements = extractRecipeRequirements({
      name: "Elegant Garden",
      description: [
        "An elegant basket arrangement designed with graceful flowers and a ribbon of memories for a polished presentation.",
        "Arrangement includes:",
        "• 6 Red Roses",
        "• 2 Pink Dahlias",
        "• Glass vase",
      ].join("\n"),
    });
    expect(requirements.map(({ phrase }) => phrase.toLowerCase())).toEqual([
      "red roses",
      "pink dahlias",
      "glass vase",
    ]);

    const proseOnly = generationTarget({
      name: "Meaningful Moments",
      description: "A rose symbolizes love. An orchid represents elegance.",
      category: "Editorial",
    });
    expect(extractRecipeRequirements(proseOnly)).toEqual([]);
    expect(generateRecipeSuggestion(proseOnly, [], [
      { baseItemId: 1, baseItemName: "Rose", quantity: 1 },
      { baseItemId: 2, baseItemName: "Orchid", quantity: 1 },
    ]).lines).toEqual([]);
  });

  it("does not treat bare paper in a Product name as wrapping paper", () => {
    const requirements = extractRecipeRequirements({ name: "Paper Flowers" });
    expect(requirements.every(({ subtype }) => subtype !== "wrapping_paper")).toBe(true);
  });

  it("retains an independently stated concrete tag alongside description requirements", () => {
    const requirements = extractRecipeRequirements({
      name: "Tagged Bouquet",
      description: "Bouquet includes:\n• 2 Red Roses",
      tags: ["Black wrapping paper"],
    });
    expect(requirements.map(({ phrase }) => phrase)).toEqual(expect.arrayContaining([
      "Red Roses",
      "Black wrapping paper",
    ]));
  });

  it("extracts concrete supported components from category and tag provenance without treating generic categories as components", () => {
    const requirements = extractRecipeRequirements({
      name: "Custom Bundle",
      category: "Flowers",
      tags: ["12 Red Roses", "Wrapping Paper"],
    });
    expect(requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ subtype: "botanical", evidence: expect.objectContaining({ sourceField: "tag", sourceIndex: 0 }) }),
      expect.objectContaining({ subtype: "wrapping_paper", evidence: expect.objectContaining({ sourceField: "tag", sourceIndex: 1 }) }),
    ]));
    expect(requirements.some((requirement) => requirement.phrase === "Flowers")).toBe(false);
  });

  it("keeps category-only formats as non-blocking disagreements, never Recipe requirements", () => {
    const bouquetConflict = {
      name: "100 Rose Majesty Bouquet",
      description: "Bouquet includes:\n• 100 Red Roses",
      category: "Flower Boxes",
    };
    expect(extractRecipeRequirements(bouquetConflict).map(({ phrase }) => phrase)).toEqual(["Red Roses"]);
    expect(extractProductStructure(bouquetConflict).conflicts).toEqual([]);
    expect(extractProductStructure(bouquetConflict).formatResolution.disagreements)
      .toEqual(expect.arrayContaining([expect.objectContaining({ conflicting: "Flower Box", strength: "weak" })]));

    const vaseConflict = {
      name: "Summer Fever Box",
      description: [
        "Flower box includes:",
        "• 10 Cherry Brandy Roses",
        "• Flower Box 40 cm Length × 17 cm Width × 20 cm Height",
      ].join("\n"),
      category: "Flower Vases",
    };
    expect(extractRecipeRequirements(vaseConflict).map(({ phrase }) => phrase)).toEqual(expect.arrayContaining([
      "Flower Box",
      "Cherry Brandy Roses",
    ]));
    expect(extractProductStructure(vaseConflict).conflicts).toEqual([]);
    expect(extractProductStructure(vaseConflict).formatResolution.disagreements)
      .toEqual(expect.arrayContaining([expect.objectContaining({ conflicting: "Vase Arrangement", strength: "weak" })]));
  });

  it("does not duplicate a name requirement repeated by category or tags", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({
        name: "12 Red Roses Bouquet",
        category: "Red Rose",
        tags: ["Red Rose"],
      }),
      [],
      [baseItems[0]],
    );
    expect(suggestion.requirements.filter((requirement) => requirement.subtype === "botanical")).toHaveLength(1);
    expect(suggestion.lines.filter((line) => line.baseItemId === 1)).toEqual([
      expect.objectContaining({ quantity: 12 }),
    ]);
  });

  it("recognizes standalone gift products and rejects a cross-component lexical candidate", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ name: "Bundle includes 1 Teddy Bear and 12 Red Roses", category: null }),
      [],
      [
        { baseItemId: 61, baseItemName: "Teddy Bear", quantity: 1 },
        { baseItemId: 62, baseItemName: "Red Rose Gold Ribbon", quantity: 1 },
        { baseItemId: 63, baseItemName: "Red Rose Chocolate", quantity: 1 },
        { baseItemId: 64, baseItemName: "Red Rose Teddy Bear", quantity: 1 },
        { baseItemId: 65, baseItemName: "Red Rose Perfume", quantity: 1 },
        { baseItemId: 66, baseItemName: "Red Rose Candle", quantity: 1 },
        { baseItemId: 67, baseItemName: "Red Rose Mug", quantity: 1 },
      ],
    );
    expect(suggestion.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ subtype: "product", resolution: "matched" }),
      expect.objectContaining({ subtype: "botanical", resolution: "no_match" }),
    ]));
    expect(suggestion.lines).toEqual([
      expect.objectContaining({ baseItemId: 61, quantity: 1, requirementId: expect.stringMatching(/^req_/) }),
    ]);
  });

  it("keeps repeated identical components distinct and stable", () => {
    const target = { name: "1 Latex Balloon + 1 Latex Balloon" };
    const requirements = extractRecipeRequirements(target);
    expect(requirements).toHaveLength(2);
    expect(new Set(requirements.map((requirement) => requirement.requirementId)).size).toBe(2);
    expect(extractRecipeRequirements(target).map((requirement) => requirement.requirementId))
      .toEqual(requirements.map((requirement) => requirement.requirementId));
  });

  it("keeps supported no-match requirements independent of Base Item availability", () => {
    const target = generationTarget({ name: "Bundle includes 2 Foil Balloons and Wrapping Paper" });
    const empty = generateRecipeSuggestion(target, [], []);
    const unrelated = generateRecipeSuggestion(target, [], [
      { baseItemId: 99, baseItemName: "Luxury Ribbon", quantity: 1 },
    ]);
    expect(empty.requirements.map(({ subtype, resolution }) => ({ subtype, resolution }))).toEqual(
      unrelated.requirements.map(({ subtype, resolution }) => ({ subtype, resolution })),
    );
    expect(empty.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ subtype: "balloon", resolution: "no_match" }),
      expect.objectContaining({ subtype: "wrapping_paper", resolution: "no_match" }),
    ]));
  });

  it("allows similar recipes to support candidates but never create unrelated lines or quantities", () => {
    const support = product({
      id: 700,
      name: "12 Red Roses Bouquet",
      recipes: [
        { baseItemId: 1, baseItemName: "Red Roses", quantity: 99 },
        { baseItemId: 77, baseItemName: "Unrelated Chocolate", quantity: 5 },
      ],
    });
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 701, name: "12 Red Roses Bouquet" }),
      [support],
      [baseItems[0]],
    );
    expect(suggestion.lines).toEqual([
      expect.objectContaining({ baseItemId: 1, quantity: 12, requirementId: expect.stringMatching(/^req_/) }),
    ]);
    expect(suggestion.lines.some((line) => line.baseItemId === 77)).toBe(false);
    expect(suggestion.requirements[0].similarEvidence).toEqual([
      expect.objectContaining({ baseItemId: 1, supportingProductIds: [700] }),
    ]);
  });

  it("preserves requirement identity and quantity through contextual red-rose resolution", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 702, name: "20 Red Roses Flower Box" }),
      [],
      [
        { baseItemId: 81, baseItemName: "Red Rose 40cm", quantity: 1 },
        { baseItemId: 82, baseItemName: "Red Rose 60cm", quantity: 1 },
      ],
      undefined,
      undefined,
      [{
        resolverBaseItemId: 81,
        canonicalFormats: ["Flower Box"],
        ingredientFamily: "rose",
        color: "red",
        stemLengthCm: 40,
      }],
    );
    const roseRequirement = suggestion.requirements.find((requirement) => requirement.subtype === "botanical")!;
    expect(suggestion.lines.find((line) => line.baseItemId === 81)).toMatchObject({
      quantity: 20,
      requirementId: roseRequirement.requirementId,
      contextualRuleProvenance: expect.objectContaining({ resolverBaseItemId: 81 }),
    });
    expect(suggestion.contextualRuleDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resolverBaseItemId: 81,
        outcome: "applied",
        requirementId: roseRequirement.requirementId,
        independentlyVerifiedGovernedValue: 40,
        preserved: expect.objectContaining({
          quantity: 20,
          unit: roseRequirement.unit,
          evidence: roseRequirement.evidence,
        }),
      }),
    ]));
  });

  it("keeps sponge and metal-ring additions as the only requirement-less hidden lines", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 703, name: "Medium Round Flower Box with 3 Latex Balloons and 12 Red Roses" }),
      [],
      baseItems,
    );
    const hidden = suggestion.lines.filter((line) => line.hiddenRuleKey);
    expect(hidden.map((line) => line.hiddenRuleKey)).toEqual(expect.arrayContaining([
      "balloon_metal_ring",
      "flower_box_round_medium_sponge",
    ]));
    expect(hidden.every((line) => line.requirementId == null)).toBe(true);
    expect(suggestion.lines.filter((line) => !line.hiddenRuleKey).every((line) => !!line.requirementId)).toBe(true);
  });

  it("reports duplicates, incorrect extras, missing items, and incorrect quantities accurately", () => {
    const target = product({ id: 300, name: "Balloon set" });
    const { recipes: _targetRecipe, ...generationTarget } = target;
    const suggestion = generateRecipeSuggestion(
      generationTarget,
      [],
      baseItems,
    );
    // Construct a deliberately imperfect suggestion through normal inputs:
    // duplicated Base Item ids are normalized by the recipe map comparison.
    suggestion.lines = [
      {
        ...baseItems[4],
        quantity: 4,
        source: "deterministic_rule",
        confidence: "high",
        reason: "text",
        hiddenRuleKey: null,
        unresolved: false,
      },
      {
        ...baseItems[3],
        quantity: 2,
        source: "similar_product",
        confidence: "medium",
        reason: "evidence",
        hiddenRuleKey: null,
        unresolved: false,
      },
      {
        ...baseItems[3],
        quantity: 2,
        source: "similar_product",
        confidence: "medium",
        reason: "duplicate evidence",
        hiddenRuleKey: null,
        unresolved: false,
      },
    ];
    const comparison = compareRecipeSuggestion(
      suggestion,
      [
        { ...baseItems[3], quantity: 5 },
        { ...baseItems[0], quantity: 1 },
      ],
      target,
    );

    expect(comparison.baseItem).toMatchObject({ matchedCount: 1, precision: 0.5, recall: 0.5 });
    expect(comparison.quantity).toMatchObject({ comparedCount: 1, correctCount: 0, accuracy: 0 });
    expect(comparison.missingItems).toEqual([expect.objectContaining({ baseItemId: 1 })]);
    expect(comparison.incorrectExtras).toEqual([expect.objectContaining({ baseItemId: 5 })]);
    expect(comparison.hiddenRule).toMatchObject({ expectedCount: 1, matchedCount: 0, accuracy: 0 });
  });

  it("preserves no-match outcomes for manual review", () => {
    const target = product({ id: 400, name: "Mystery custom arrangement", description: "Made to order" });
    const { recipes: _targetRecipe, ...generationTarget } = target;
    const suggestion = generateRecipeSuggestion(generationTarget, [], baseItems);
    const comparison = compareRecipeSuggestion(suggestion, [{ ...baseItems[0], quantity: 1 }], target);

    expect(suggestion.lines).toEqual([]);
    expect(suggestion.unresolvedLines).toHaveLength(1);
    expect(comparison.baseItem.recall).toBe(0);
    expect(comparison.unresolvedLines).toHaveLength(1);
  });

  it("hard-excludes canonical color contradictions even when an approved alias agrees", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 900, name: "5 Red Roses" }),
      [],
      [{
        baseItemId: 901,
        baseItemName: "Pink Rose",
        quantity: 1,
        metadata: { approvedAliases: ["Red Rose"] },
      }],
    );
    const diagnostic = suggestion.requirements[0].candidateCompatibility?.[0];
    expect(diagnostic).toMatchObject({
      survivor: false,
      comparisons: { color: { state: "incompatible" } },
    });
    expect(diagnostic?.attributes.color).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "pink", source: "canonical_name" }),
      expect.objectContaining({ value: "red", source: "approved_alias" }),
    ]));
    expect(suggestion.lines).toEqual([]);
  });

  it("observes pre-compatibility retrieval without changing matcher behavior", () => {
    const target = generationTarget({ id: 899, name: "5 Red Roses" });
    const survivor = { baseItemId: 8991, baseItemName: "Red Rose", quantity: 1 };
    const contradiction = { baseItemId: 8992, baseItemName: "Pink Rose", quantity: 1 };
    const instrumented = generateRecipeSuggestion(target, [], [contradiction, survivor]);
    const legacyEquivalent = generateRecipeSuggestion(target, [], [survivor]);
    const requirement = instrumented.requirements[0];

    expect(requirement.preCompatibilityCandidateBaseItemIds).toEqual([8992, 8991]);
    expect(requirement.candidateBaseItemIds).toEqual([8991]);
    expect(requirement.candidateCompatibility).toEqual([
      expect.objectContaining({ baseItemId: 8992, survivor: false }),
      expect.objectContaining({ baseItemId: 8991, survivor: true }),
    ]);

    const withoutDiagnosticOnlyFields = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutDiagnosticOnlyFields);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([key]) =>
              key !== "preCompatibilityCandidateBaseItemIds"
              && key !== "candidateCompatibility")
            .map(([key, item]) => [key, withoutDiagnosticOnlyFields(item)]),
        );
      }
      return value;
    };

    expect(withoutDiagnosticOnlyFields(instrumented)).toEqual(
      withoutDiagnosticOnlyFields(legacyEquivalent),
    );
  });

  it("hard-excludes an authoritative metadata contradiction even when canonical color agrees", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 901, name: "5 Red Roses" }),
      [],
      [{ baseItemId: 902, baseItemName: "Red Rose", quantity: 1, metadata: { approved: true, color: "Pink" } }],
    );
    const color = suggestion.requirements[0].candidateCompatibility?.[0].comparisons.color;
    expect(color).toMatchObject({ state: "incompatible", candidate: expect.arrayContaining(["red", "pink"]) });
    expect(color?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "canonical_name", value: "red" }),
      expect.objectContaining({ source: "approved_metadata", value: "pink" }),
    ]));
    expect(suggestion.requirements[0].candidateBaseItemIds).toEqual([]);
  });

  it("keeps a sole candidate with unknown explicit color in the existing ambiguous state", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 902, name: "5 Red Roses" }),
      [],
      [{ baseItemId: 903, baseItemName: "Rose", quantity: 1 }],
    );
    expect(suggestion.requirements[0]).toMatchObject({
      resolution: "ambiguous",
      candidateBaseItemIds: [903],
      candidateCompatibility: [
        expect.objectContaining({
          hasUnknownExplicitDiscriminator: true,
          comparisons: expect.objectContaining({ color: expect.objectContaining({ state: "unknown" }) }),
        }),
      ],
    });
    expect(suggestion.lines).toEqual([]);
  });

  it("separates botanical varieties and enforces explicit stem length", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 904, name: "8 Red Spray Roses, stem length 60 cm" }),
      [],
      [
        { baseItemId: 905, baseItemName: "Red Rose 60cm", quantity: 1 },
        { baseItemId: 906, baseItemName: "Red Spray Rose 40cm", quantity: 1 },
        { baseItemId: 907, baseItemName: "Red Spray Rose 60cm", quantity: 1 },
      ],
    );
    expect(suggestion.lines).toEqual([expect.objectContaining({ baseItemId: 907, quantity: 8 })]);
    const diagnostics = suggestion.requirements[0].candidateCompatibility ?? [];
    expect(diagnostics.find(({ baseItemId }) => baseItemId === 905)?.comparisons.botanicalVariety.state).toBe("incompatible");
    expect(diagnostics.find(({ baseItemId }) => baseItemId === 906)?.comparisons.stemLength.state).toBe("incompatible");
  });

  it("compares same-label dimensions with narrow conversion tolerance", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({
        id: 908,
        name: "Glass Vase",
        description: "Arrangement includes:\n• Glass vase, height 10 in, diameter 20 cm",
      }),
      [],
      [
        { baseItemId: 909, baseItemName: "Glass Vase height 25.4cm diameter 20cm", quantity: 1 },
        { baseItemId: 910, baseItemName: "Glass Vase height 26cm diameter 20cm", quantity: 1 },
        { baseItemId: 911, baseItemName: "Glass Vase height 25.4cm diameter 21cm", quantity: 1 },
      ],
    );
    expect(suggestion.lines).toEqual([expect.objectContaining({ baseItemId: 909 })]);
    const diagnostics = suggestion.requirements.find(({ subtype }) => subtype === "container")?.candidateCompatibility ?? [];
    expect(diagnostics.find(({ baseItemId }) => baseItemId === 910)?.comparisons.height.state).toBe("incompatible");
    expect(diagnostics.find(({ baseItemId }) => baseItemId === 911)?.comparisons.diameter.state).toBe("incompatible");
  });

  it("compares true package size without treating it as Recipe quantity", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 912, name: "Pack of 12 Red Roses" }),
      [],
      [
        { baseItemId: 913, baseItemName: "Red Roses pack of 12", quantity: 1 },
        { baseItemId: 914, baseItemName: "Red Roses pack of 24", quantity: 1 },
      ],
    );
    expect(suggestion.requirements[0]).toMatchObject({
      quantity: 1,
      attributes: { packageSize: 12 },
    });
    expect(suggestion.lines).toEqual([expect.objectContaining({ baseItemId: 913, quantity: 1 })]);
    expect(suggestion.requirements[0].candidateCompatibility
      ?.find(({ baseItemId }) => baseItemId === 914)?.comparisons.packageSize.state).toBe("incompatible");
  });

  it("never derives a contextual stem length from an arbitrary Base Item code", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 915, name: "20 Red Roses Flower Box" }),
      [],
      [
        { baseItemId: 916, baseItemName: "Red Rose", baseItemCode: "ROSE-RED-40CM", quantity: 1 },
        { baseItemId: 917, baseItemName: "Red Rose 60cm", quantity: 1 },
      ],
      undefined,
      undefined,
      [{
        resolverBaseItemId: 916,
        canonicalFormats: ["Flower Box"],
        ingredientFamily: "rose",
        color: "red",
        stemLengthCm: 40,
      }],
    );
    expect(suggestion.lines).toEqual([]);
    expect(suggestion.requirements[0].resolution).toBe("ambiguous");
  });

  it("allows approved metadata to prove a governed contextual length, but not aliases", () => {
    const metadataProven = generateRecipeSuggestion(
      generationTarget({ id: 918, name: "20 Red Roses Flower Box" }),
      [],
      [
        { baseItemId: 919, baseItemName: "Red Rose", quantity: 1, metadata: { approved: true, stemLengthCm: 40 } },
        { baseItemId: 920, baseItemName: "Red Rose 60cm", quantity: 1 },
      ],
      undefined,
      undefined,
      [{ resolverBaseItemId: 919, canonicalFormats: ["Flower Box"], ingredientFamily: "rose", color: "red", stemLengthCm: 40 }],
    );
    expect(metadataProven.lines).toEqual([expect.objectContaining({ baseItemId: 919 })]);

    const aliasOnly = generateRecipeSuggestion(
      generationTarget({ id: 921, name: "20 Red Roses Flower Box" }),
      [],
      [
        { baseItemId: 922, baseItemName: "Red Rose", quantity: 1, metadata: { approvedAliases: ["Red Rose 40cm"] } },
        { baseItemId: 923, baseItemName: "Red Rose 60cm", quantity: 1 },
      ],
      undefined,
      undefined,
      [{ resolverBaseItemId: 922, canonicalFormats: ["Flower Box"], ingredientFamily: "rose", color: "red", stemLengthCm: 40 }],
    );
    expect(aliasOnly.lines).toEqual([]);
  });

  it("rejects contextual resolution when canonical and approved stem lengths disagree", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 924, name: "20 Red Roses Flower Box" }),
      [],
      [
        { baseItemId: 925, baseItemName: "Red Rose 40cm", quantity: 1, metadata: { approved: true, stemLengthCm: 60 } },
        { baseItemId: 926, baseItemName: "Red Rose 60cm", quantity: 1 },
      ],
      undefined,
      undefined,
      [{ resolverBaseItemId: 925, canonicalFormats: ["Flower Box"], ingredientFamily: "rose", color: "red", stemLengthCm: 40 }],
    );
    expect(suggestion.lines).toEqual([]);
    expect(suggestion.requirements[0].candidateCompatibility?.find(({ baseItemId }) => baseItemId === 925)
      ?.attributes.stemLength).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "canonical_name", value: 40 }),
        expect.objectContaining({ source: "approved_metadata", value: 60 }),
      ]));
  });

  it("hard-excludes a stem candidate when agreeing canonical length conflicts with approved metadata", () => {
    const suggestion = generateRecipeSuggestion(
      generationTarget({ id: 927, name: "5 Red Roses, stem length 40 cm" }),
      [],
      [{ baseItemId: 928, baseItemName: "Red Rose 40cm", quantity: 1, metadata: { approved: true, stemLengthCm: 60 } }],
    );
    const stem = suggestion.requirements[0].candidateCompatibility?.[0].comparisons.stemLength;
    expect(stem).toMatchObject({ state: "incompatible", candidate: expect.arrayContaining([40, 60]) });
    expect(suggestion.lines).toEqual([]);
  });

  it("uses explicit extended catalog colors as authoritative contradictions", () => {
    const result = generateRecipeSuggestion(
      { id: 610, name: "5 Red Roses" },
      [],
      [
        { baseItemId: 1, baseItemName: "Red Rose", quantity: 1 },
        { baseItemId: 2, baseItemName: "Fuchsia Rose", quantity: 1 },
        { baseItemId: 3, baseItemName: "Peach Rose", quantity: 1 },
        { baseItemId: 4, baseItemName: "Lilac Rose", quantity: 1 },
      ],
    );

    const requirement = result.requirements.find(({ phrase }) => /red roses/i.test(phrase));
    expect(requirement?.candidateBaseItemIds).toEqual([1]);
    for (const candidateId of [2, 3, 4]) {
      expect(requirement?.candidateCompatibility?.find(({ baseItemId }) => baseItemId === candidateId))
        .toMatchObject({ survivor: false, hardExclusions: [expect.stringContaining("color: required red")] });
    }
  });

  it("normalizes real catalog hyphenated balloon sizes and recognizes helium-fill candidates", () => {
    const result = generateRecipeSuggestion(
      {
        id: 611,
        name: "Great Dad Balloon",
        description: "Great Dad Balloon, 18 inch helium-filled foil balloon",
      },
      [],
      [
        { baseItemId: 1, baseItemName: "Great Dad Foil Balloon 18- inch", quantity: 1 },
        { baseItemId: 2, baseItemName: "Great Dad Foil Balloon 40- inch", quantity: 1 },
        { baseItemId: 3, baseItemName: "Helium For 18 - inch Latex Balloon ( 17 L )", quantity: 1 },
        { baseItemId: 4, baseItemName: "Helium For 40 - inch Latex Balloon ( 87 L )", quantity: 1 },
      ],
      { flowerBoxSponge: false, balloonMetalRing: false },
    );

    const balloon = result.requirements.find(({ subtype }) => subtype === "balloon");
    expect(balloon?.preCompatibilityCandidateBaseItemIds).toEqual([1, 2, 3, 4]);
    expect(balloon?.candidateBaseItemIds).toEqual([1]);
    expect(balloon?.candidateCompatibility?.find(({ baseItemId }) => baseItemId === 2))
      .toMatchObject({ survivor: false, hardExclusions: [expect.stringContaining("balloonSize")] });

    const helium = result.requirements.find(({ subtype }) => subtype === "helium_fill");
    expect(helium?.preCompatibilityCandidateBaseItemIds).toEqual([1, 2, 3, 4]);
    expect(helium?.candidateBaseItemIds).toEqual([3]);
    expect(helium?.resolution).toBe("matched");
    expect(helium?.candidateCompatibility?.find(({ baseItemId }) => baseItemId === 4))
      .toMatchObject({ survivor: false, hardExclusions: [expect.stringContaining("balloonSize")] });
  });
});