/**
 * Deterministic recipe suggestion engine used by the accuracy benchmark.
 *
 * This module deliberately has no database or live-recipe writes. Callers pass
 * the target product without its recipe and a separate list of approved
 * supporting products. That makes the leave-one-out boundary explicit and
 * testable.
 */
import { createHash } from "node:crypto";

export type RecipeEvidenceSource =
  | "deterministic_rule"
  | "similar_product"
  | "ai_assisted"
  | "unresolved"
  | "conflict";

export type SuggestionConfidence = "high" | "medium" | "low" | "no_match";

export type RecipeLineInput = {
  baseItemId: number;
  baseItemName: string;
  baseItemCode?: string | null;
  quantity: number;
  /**
   * Optional catalog metadata.  It is deliberately advisory unless it is
   * explicitly approved/confirmed; image-derived metadata must never identify
   * an ingredient or settle a numeric variant.
   */
  metadata?: Record<string, unknown> | null;
};

/** Only deterministic operational additions are exempt from semantic requirements. */
export function isGovernedOperationalHiddenRuleKey(key: unknown): boolean {
  return typeof key === "string"
    && (key === "balloon_metal_ring" || /^flower_box_(round|heart)_.+_sponge$/.test(key));
}

export type SuggestionLine = RecipeLineInput & {
  confidence: SuggestionConfidence;
  source: RecipeEvidenceSource;
  reason: string;
  hiddenRuleKey: string | null;
  unresolved: boolean;
  requirementId?: string | null;
  requirementEvidence?: RecipeRequirementEvidence | null;
  requirementProvenance?: RecipeRequirement | null;
  contextualRuleProvenance?: {
    resolverBaseItemId: number;
    canonicalFormat: CanonicalProductFormat;
    stemLengthCm: number | null;
  } | null;
};

export type RecipeRequirementKind = "ingredient" | "container" | "component";
export type RecipeRequirementResolution = "matched" | "ambiguous" | "no_match";
export type RecipeRequirementEvidence = {
  sourceField: "name" | "description" | "descriptionAr" | "tag";
  sourceIndex: number;
  lineIndex: number;
  componentIndex: number;
  occurrence: number;
  exactPhrase: string;
  normalizedPhrase: string;
  span: { start: number; end: number };
  semanticSpan?: { start: number; end: number };
};
export type RecipeRequirement = {
  requirementId: string;
  kind: RecipeRequirementKind;
  subtype?: string | null;
  category?: string | null;
  phrase: string;
  quantity: number;
  unit: string | null;
  attributes: Record<string, unknown>;
  /** Observational retrieval output captured before compatibility filtering. */
  preCompatibilityCandidateBaseItemIds?: number[];
  candidateBaseItemIds: number[];
  resolution: RecipeRequirementResolution;
  evidence: RecipeRequirementEvidence;
  additionalEvidence?: RecipeRequirementEvidence[];
  similarEvidence: Array<{ baseItemId: number; supportingProductIds: number[] }>;
  candidateCompatibility?: CandidateCompatibilityDiagnostic[];
};

export type CompatibilityState = "compatible" | "incompatible" | "unknown";
export type CandidateAttributeEvidence = {
  value: unknown;
  source: "canonical_name" | "approved_metadata" | "approved_alias" | "governed_package";
  sourcePhrase: string;
};
export type CandidateCompatibilityDiagnostic = {
  baseItemId: number;
  attributes: Record<string, CandidateAttributeEvidence[]>;
  comparisons: Record<string, {
    state: CompatibilityState;
    required: unknown;
    candidate: unknown[];
    sources: CandidateAttributeEvidence[];
  }>;
  hardExclusions: string[];
  hasUnknownExplicitDiscriminator: boolean;
  survivor: boolean;
};

export type SuggestionProduct = {
  id: number;
  name: string;
  description?: string | null;
  /** Existing Arabic catalog text, retained verbatim and never auto-translated. */
  descriptionAr?: string | null;
  category?: string | null;
  tags?: string[] | null;
  recipes: RecipeLineInput[];
  metadata?: Record<string, unknown> | null;
  /** Limits recipe-evidence aggregation when the caller already has a shortlist. */
  activeCandidateIds?: number[] | null;
};

/** Generation receives product descriptors, never a target approved recipe. */
export type RecipeSuggestionTarget = Omit<SuggestionProduct, "recipes"> & {
  recipes?: never;
};

export type RecipeSuggestion = {
  targetProductId: number;
  engineVersion: string;
  /** Explainable text-only extraction; metadata/images are never used here. */
  structure: ProductStructure;
  requirements: RecipeRequirement[];
  lines: SuggestionLine[];
  similarProducts: Array<{ productId: number; name: string; score: number }>;
  conflicts: Array<{
    baseItemId: number;
    baseItemName: string;
    quantities: number[];
    supportingProductIds: number[];
  }>;
  unresolvedLines: string[];
  unresolvedRequirements: Array<{
    requirementId: string;
    requirement: string;
    quantity: number;
    reason: string;
    candidateBaseItemIds?: number[];
    requirementProvenance?: RecipeRequirement;
  }>;
  evidenceSummary: Record<RecipeEvidenceSource, number>;
  leaveOneOut: {
    directRecipeWithheld: true;
    excludedProductId: number;
    supportingProductIds: number[];
  };
  ruleSetVersion: string;
  contextualRuleDiagnostics?: ContextualRuleDiagnostic[];
};

export type OperationalRuleActivation = {
  flowerBoxSponge: boolean;
  balloonMetalRing: boolean;
};

export type ApprovedContextualRule = {
  ruleId?: number | string | null;
  ruleKey?: string | null;
  resolverBaseItemId: number;
  canonicalFormats: CanonicalProductFormat[];
  ingredientFamily?: string | null;
  color?: string | null;
  stemLengthCm?: number | null;
};

export const CANONICAL_PRODUCT_FORMATS = [
  "Hand Bouquet",
  "Flower Box",
  "Vase Arrangement",
  "Flower Basket",
  "Wooden Letter",
  "Wooden Heart",
  "Balloon Product",
  "Bundle",
  "Single Gift Item",
  "Unknown",
] as const;
export type CanonicalProductFormat = (typeof CANONICAL_PRODUCT_FORMATS)[number];

export type StructuredEvidence<T> = {
  value: T | null;
  sourcePhrases: string[];
  language: "en" | "ar" | "mixed" | "unknown";
  confidence: SuggestionConfidence;
};

export type ProductFormatObservation = {
  sourceField: "name" | "description" | "descriptionAr" | "category" | "tag" | "approved_metadata" | "diagnostic_metadata";
  sourceIndex: number;
  span: { start: number; end: number };
  phrase: string;
  canonicalFormat: CanonicalProductFormat;
  strength: "structural" | "name" | "approved_metadata" | "weak";
  semanticRole: "primary_arrangement_candidate" | "wrapper_commercial" | "contained_component";
  authorizing: boolean;
  participatesInResolution: boolean;
  rationale: string;
};

export type ProductFormatResolution = {
  observations: ProductFormatObservation[];
  deduplicatedResolutionEvidence: Array<ProductFormatObservation & {
    supportingObservations: ProductFormatObservation[];
  }>;
  resolvedPrimaryFormat: CanonicalProductFormat | null;
  authoritativePrimaryFormat: CanonicalProductFormat | null;
  contextualRuleFormatEligible: boolean;
  wrapperFormats: CanonicalProductFormat[];
  disagreements: Array<{ selected: CanonicalProductFormat | null; conflicting: CanonicalProductFormat; sourceField: string; strength: string }>;
  unresolvedReason: string | null;
};

export type ContextualRuleDiagnostic = {
  ruleId: number | string | null;
  ruleKey: string | null;
  resolverBaseItemId: number;
  canonicalFormats: CanonicalProductFormat[];
  authoritativePrimaryFormat: CanonicalProductFormat | null;
  outcome: "applied" | "rejected";
  reason: string;
  requirementId: string;
  preserved: {
    quantity: number;
    unit: string | null;
    evidence: RecipeRequirementEvidence;
    additionalEvidence: RecipeRequirementEvidence[];
    provenance: RecipeRequirementEvidence[];
  };
  independentlyVerifiedGovernedValue: number | null;
};

export type NumericDimension = {
  value: number;
  unit: "mm" | "cm" | "m" | "in";
  centimeters: number;
  sourcePhrase: string;
};

export type ProductStructure = {
  ingredientFamily: StructuredEvidence<string>;
  ingredientType: StructuredEvidence<string>;
  color: StructuredEvidence<string>;
  quantity: StructuredEvidence<number>;
  packageCount: StructuredEvidence<number>;
  container: StructuredEvidence<string>;
  productFormat: StructuredEvidence<CanonicalProductFormat>;
  formatResolution: ProductFormatResolution;
  material: StructuredEvidence<string>;
  shape: StructuredEvidence<string>;
  stemLength: StructuredEvidence<NumericDimension>;
  dimensions: NumericDimension[];
  classificationEvidence: string[];
  conflicts: string[];
  uncertainty: string[];
};

const DEFAULT_OPERATIONAL_RULES: OperationalRuleActivation = {
  flowerBoxSponge: true,
  balloonMetalRing: true,
};

export const RECIPE_SUGGESTION_ENGINE_VERSION = "semantic-source-aware-formats-v3";
/** Bump whenever confirmed operational rules or their precedence changes. */
export const RECIPE_SUGGESTION_RULESET_VERSION = "governed-contextual-rules-v2";
export const RECIPE_SUGGESTION_ALIAS_VERSION = "governed-base-item-aliases-v1";
export const RECIPE_SUGGESTION_METADATA_VERSION = "governed-base-item-metadata-v1";
export const RECIPE_SUGGESTION_PROMPT_VERSION = "bounded-candidate-ranking-v2";
export const RECIPE_FORMAT_POLICY_VERSION = "semantic-format-resolution-v1";
export const RECIPE_COMPATIBILITY_POLICY_VERSION = "4939-compatibility-v2";
export const RECIPE_SIMILAR_POLICY_VERSION = "leave-one-out-similar-recipe-v1";

export type ProductionRecipeMatcherConfiguration = {
  baseItems: RecipeLineInput[];
  operationalRules: OperationalRuleActivation;
  contextualRules: ApprovedContextualRule[];
  boundedAi: { policyVersion: string; model: string | null; enabled: boolean };
};

export type ProductionRecipeMatcherRun = {
  suggestion: RecipeSuggestion;
  configurationFingerprint: string;
  caseInputFingerprint: string;
  configurationSnapshot: Record<string, unknown>;
  caseInputSnapshot: Record<string, unknown>;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function deterministicRecipeFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

const TRUSTED_MATCHING_METADATA_KEYS = new Set([
  "ingredientFamily", "ingredient_family", "flowerType", "flower_type", "type",
  "botanicalVariety", "botanical_variety", "variety", "subtype",
  "color", "colour", "stemLengthCm", "stem_length_cm", "stemLength", "stem_length",
  "container", "containerType", "container_type", "shape", "material",
  "packageName", "package_name", "packageSize", "package_size", "packageCount", "package_count",
  "balloonType", "balloon_type", "balloonSizeCm", "balloon_size_cm",
  "fill", "gas", "heightCm", "height_cm", "widthCm", "width_cm",
  "lengthCm", "length_cm", "diameterCm", "diameter_cm", "depthCm", "depth_cm",
  "dimensions",
]);

function matchingMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const aliases = Array.isArray(metadata.approvedAliases)
    ? metadata.approvedAliases.filter((value): value is string => typeof value === "string").sort()
    : [];
  const isApproved = metadata.confirmed === true || metadata.approved === true || metadata.status === "approved";
  const approvedValues = isApproved
    ? Object.fromEntries(Object.entries(metadata).filter(([key, value]) =>
        TRUSTED_MATCHING_METADATA_KEYS.has(key)
        && value !== undefined
        && value !== null
        && !(Array.isArray(value) && value.length === 0)))
    : {};
  const governedPackageValues = metadata.governedPackageFacts === true
    ? Object.fromEntries(Object.entries(metadata).filter(([key, value]) =>
        ["packageName", "package_name", "packageSize", "package_size", "packageCount", "package_count"].includes(key)
        && value !== undefined
        && value !== null))
    : {};
  const normalized = {
    ...(Object.keys(approvedValues).length > 0 ? { approved: true, ...approvedValues } : {}),
    ...(Object.keys(governedPackageValues).length > 0
      ? { governedPackageFacts: true, ...governedPackageValues }
      : {}),
    ...(aliases.length > 0 ? { approvedAliases: aliases } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function productMatchingInput(
  product: Pick<SuggestionProduct, "id" | "name" | "description" | "descriptionAr" | "category" | "tags" | "metadata" | "activeCandidateIds">,
): Record<string, unknown> {
  const approvedFormat = approvedProductFormatMetadata(product.metadata);
  const metadata = {
    ...(approvedFormat ? { approved: true, productFormat: approvedFormat } : {}),
    ...(Array.isArray(product.metadata?.activeCandidateIds)
      ? { activeCandidateIds: product.metadata.activeCandidateIds.filter((id): id is number => typeof id === "number").sort((a, b) => a - b) }
      : {}),
  };
  return {
    id: product.id,
    name: product.name,
    description: product.description ?? null,
    descriptionAr: product.descriptionAr ?? null,
    category: product.category ?? null,
    tags: [...(product.tags ?? [])],
    activeCandidateIds: [...(product.activeCandidateIds ?? [])].sort((a, b) => a - b),
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
  };
}

export function assembleProductionRecipeMatcher(
  configuration: ProductionRecipeMatcherConfiguration,
): ProductionRecipeMatcherConfiguration {
  return {
    baseItems: [...configuration.baseItems].map((item) => ({
      ...item,
      metadata: matchingMetadata(item.metadata),
    })).sort((a, b) => a.baseItemId - b.baseItemId),
    operationalRules: { ...configuration.operationalRules },
    contextualRules: [...configuration.contextualRules].map((rule) => ({
      ...rule,
      canonicalFormats: [...rule.canonicalFormats].sort(),
    })).sort((a, b) => a.resolverBaseItemId - b.resolverBaseItemId
      || String(a.ruleKey ?? "").localeCompare(String(b.ruleKey ?? ""))),
    boundedAi: { ...configuration.boundedAi },
  };
}

export function runProductionRecipeMatcher(
  target: RecipeSuggestionTarget,
  supportingProducts: SuggestionProduct[],
  rawConfiguration: ProductionRecipeMatcherConfiguration,
): ProductionRecipeMatcherRun {
  const configuration = assembleProductionRecipeMatcher(rawConfiguration);
  const sortedSupport = [...supportingProducts]
    .filter((product) => product.id !== target.id)
    .sort((a, b) => a.id - b.id);
  const configurationSnapshot = {
    versions: {
      engine: RECIPE_SUGGESTION_ENGINE_VERSION,
      rules: RECIPE_SUGGESTION_RULESET_VERSION,
      format: RECIPE_FORMAT_POLICY_VERSION,
      compatibility: RECIPE_COMPATIBILITY_POLICY_VERSION,
      aliases: RECIPE_SUGGESTION_ALIAS_VERSION,
      metadata: RECIPE_SUGGESTION_METADATA_VERSION,
      similarRecipe: RECIPE_SIMILAR_POLICY_VERSION,
    },
    baseItems: configuration.baseItems,
    operationalRules: configuration.operationalRules,
    contextualRules: configuration.contextualRules,
    boundedAi: configuration.boundedAi,
    deterministicTolerances: { dimensionCentimeters: DIMENSION_TOLERANCE_CM },
  };
  const caseInputSnapshot = {
    target: productMatchingInput(target),
    supportingProducts: sortedSupport.map((product) => ({
      ...productMatchingInput(product),
      approvedRecipeLines: [...product.recipes].sort((a, b) => a.baseItemId - b.baseItemId),
    })),
    targetExclusion: { excludedProductId: target.id, directRecipeWithheld: true },
  };
  return {
    suggestion: generateRecipeSuggestion(
      target, sortedSupport, configuration.baseItems, configuration.operationalRules,
      undefined, configuration.contextualRules,
    ),
    configurationFingerprint: deterministicRecipeFingerprint(configurationSnapshot),
    caseInputFingerprint: deterministicRecipeFingerprint(caseInputSnapshot),
    configurationSnapshot,
    caseInputSnapshot,
  };
}

const STOP_WORDS = new Set([
  "and",
  "the",
  "with",
  "for",
  "from",
  "piece",
  "pieces",
  "unit",
  "units",
  "item",
  "items",
  "size",
  "large",
  "small",
  "medium",
]);

const MATCH_STOP_WORDS = new Set([
  "and",
  "the",
  "with",
  "for",
  "from",
  "piece",
  "pieces",
  "unit",
  "units",
  "item",
  "items",
]);

const GENERIC_ATTRIBUTE_TOKENS = new Set([
  "beige",
  "black",
  "blue",
  "brown",
  "cream",
  "gold",
  "green",
  "grey",
  "gray",
  "ivory",
  "orange",
  "pink",
  "purple",
  "red",
  "silver",
  "white",
  "yellow",
]);

function normalize(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[×x]/g, "x")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evidence<T>(value: T | null, phrases: string[], language: StructuredEvidence<T>["language"]): StructuredEvidence<T> {
  return {
    value,
    sourcePhrases: phrases,
    language: value === null ? "unknown" : language,
    confidence: value === null ? "no_match" : "high",
  };
}

function sourceLanguage(phrase: string): StructuredEvidence<string>["language"] {
  const arabic = /[\u0600-\u06ff]/.test(phrase);
  const english = /[a-z]/i.test(phrase);
  return arabic && english ? "mixed" : arabic ? "ar" : english ? "en" : "unknown";
}

/**
 * Extracts only facts printed in catalog text.  Arabic phrases are retained as
 * supplied (rather than translated), while canonical format is a separate
 * classification useful to deterministic rules.
 */
export function extractProductStructure(
  product: Pick<SuggestionProduct, "name" | "description" | "descriptionAr" | "category" | "tags" | "metadata">,
): ProductStructure {
  const raw = [
    product.name,
    product.description ?? "",
    product.descriptionAr ?? "",
    product.category ?? "",
    ...(product.tags ?? []),
  ]
    .filter(Boolean).join(" ");
  const formatResolution = resolveProductFormat(product);
  const format = formatResolution.resolvedPrimaryFormat ?? "Unknown";
  const primaryFormatObservations = formatResolution.resolvedPrimaryFormat == null
    ? []
    : formatResolution.observations.filter((observation) =>
        observation.canonicalFormat === formatResolution.resolvedPrimaryFormat
        && observation.semanticRole === "primary_arrangement_candidate"
        && observation.participatesInResolution);
  const formatPhrases = primaryFormatObservations.map(({ phrase }) => phrase);
  const flowerBoxPhrases = primaryFormatObservations
    .filter(({ canonicalFormat }) => canonicalFormat === "Flower Box")
    .map(({ phrase }) => phrase);
  const dimensions: NumericDimension[] = [];
  const dimensionPattern = /(\d+(?:\.\d+)?)\s*[-–—]?\s*(cm|mm|m|in|inch|inches|سم|ملم|متر|بوصة|بوصة)/gi;
  for (const match of raw.matchAll(dimensionPattern)) {
    const value = Number(match[1]);
    const rawUnit = match[2].toLowerCase();
    const unit: NumericDimension["unit"] = /^(mm|ملم)$/.test(rawUnit) ? "mm"
      : /^(m|متر)$/.test(rawUnit) ? "m"
        : /^(in|inch|inches|بوصة)$/.test(rawUnit) ? "in" : "cm";
    dimensions.push({
      value,
      unit,
      centimeters: unit === "mm" ? value / 10 : unit === "m" ? value * 100 : unit === "in" ? value * 2.54 : value,
      sourcePhrase: match[0],
    });
  }
  const find = (patterns: RegExp[]) => patterns.map((pattern) => raw.match(pattern)?.[0]).find(Boolean) ?? null;
  const color = find([/\b(red|white|pink|yellow|purple|orange|blue|green|black|gold|silver)\b/i, /(أحمر|حمراء|ابيض|أبيض|بيضاء|وردي|وردية|أصفر|صفراء|بنفسجي|بنفسجية|برتقالي|برتقالية|أزرق|زرقاء|أخضر|خضراء|أسود|سوداء|ذهبي|ذهبية|فضي|فضية)/]);
  const ingredient = find([/\b(?:red|white|pink|yellow|purple|orange)?\s*(roses?|tulips?|irises?|orchids?|flowers?)\b/i, /(ورد(?:ة|ات)?|زهور|توليب|سوسن|أوركيد)/]);
  const material = find([/\b(wood(?:en)?|glass|ceramic|metal|paper)\b/i, /(خشب(?:ي)?|زجاج|سيراميك|معدن|ورق)/]);
  const shape = find([/\b(round|heart|square|rectangle)\b/i, /(دائري|قلب|مربع|مستطيل)/]);
  const count = raw.match(/(?:^|\s)(\d+)\s*(?:x\s*)?(?:stems?|roses?|flowers?|pieces?|items?|بالونات?|ورود|قطع)?/i);
  const packageCount = raw.match(/(\d+)\s*(?:pack|packs|box(?:es)?|bundle(?:s)?|عبوة|صندوق)/i);
  const stem = dimensions.find((dimension) => /stem|طول|rose|ورد/i.test(raw.slice(Math.max(0, raw.indexOf(dimension.sourcePhrase) - 20), raw.indexOf(dimension.sourcePhrase) + dimension.sourcePhrase.length + 20))) ?? null;
  const conflicts = formatResolution.unresolvedReason ? [formatResolution.unresolvedReason] : [];
  const language = sourceLanguage(raw);
  return {
    ingredientFamily: evidence(ingredient ? ingredient.split(/\s+/).pop() ?? ingredient : null, ingredient ? [ingredient] : [], ingredient ? sourceLanguage(ingredient) : "unknown"),
    ingredientType: evidence(ingredient, ingredient ? [ingredient] : [], ingredient ? sourceLanguage(ingredient) : "unknown"),
    color: evidence(color, color ? [color] : [], color ? sourceLanguage(color) : "unknown"),
    quantity: evidence(count ? Number(count[1]) : null, count ? [count[0].trim()] : [], language),
    packageCount: evidence(packageCount ? Number(packageCount[1]) : null, packageCount ? [packageCount[0]] : [], language),
    container: evidence(format === "Flower Box" ? flowerBoxPhrases[0] ?? null : null, format === "Flower Box" ? flowerBoxPhrases : [], language),
    productFormat: {
      ...evidence(format, formatPhrases, language),
      confidence: formatResolution.resolvedPrimaryFormat == null ? "no_match" : "high",
    },
    formatResolution,
    material: evidence(material, material ? [material] : [], material ? sourceLanguage(material) : "unknown"),
    shape: evidence(shape, shape ? [shape] : [], shape ? sourceLanguage(shape) : "unknown"),
    stemLength: evidence(stem, stem ? [stem.sourcePhrase] : [], stem ? sourceLanguage(stem.sourcePhrase) : "unknown"),
    dimensions,
    classificationEvidence: formatResolution.observations.map(({ phrase }) => phrase),
    conflicts,
    uncertainty: [...conflicts, ...(dimensions.length > 1 ? ["Multiple numeric dimensions require review."] : [])],
  };
}

/** Backwards-friendly descriptive alias for callers that prefer extraction terminology. */
export const extractStructuredProduct = extractProductStructure;

const FORMAT_DEFINITIONS: Array<{
  format: CanonicalProductFormat;
  pattern: RegExp;
  role: ProductFormatObservation["semanticRole"];
}> = [
  { format: "Wooden Letter", pattern: /\bwood(?:en)?\s+letter\b|حرف\s+خشب/gi, role: "primary_arrangement_candidate" },
  { format: "Wooden Heart", pattern: /\bwood(?:en)?\s+heart\b|قلب\s+خشب/gi, role: "primary_arrangement_candidate" },
  { format: "Flower Box", pattern: /\bflower\s*box(?:es)?\b|بوكس\s*(?:ورد|زهور)|صندوق\s*(?:ورد|زهور)/gi, role: "primary_arrangement_candidate" },
  { format: "Flower Box", pattern: /\bbox(?:es)?\b|بوكس|صندوق/gi, role: "primary_arrangement_candidate" },
  { format: "Vase Arrangement", pattern: /\bvases?\b|مزهرية/gi, role: "primary_arrangement_candidate" },
  { format: "Flower Basket", pattern: /\b(?:flower\s+)?baskets?\b|سلة\s*(?:ورد|زهور)?/gi, role: "primary_arrangement_candidate" },
  { format: "Hand Bouquet", pattern: /\b(?:hand(?:-|\s+)tied\s+)?bouquets?\b|باقة\s+يدوية/gi, role: "primary_arrangement_candidate" },
  { format: "Balloon Product", pattern: /\bballoons?\b|بالونات?/gi, role: "primary_arrangement_candidate" },
  { format: "Bundle", pattern: /\bbundles?\b|مجموعة|باقة/gi, role: "wrapper_commercial" },
  { format: "Single Gift Item", pattern: /\b(?:single\s+)?gift\b|هدية/gi, role: "wrapper_commercial" },
];

function structurallyQualified(text: string, phrase: string, format: CanonicalProductFormat, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const lineEndMatch = text.indexOf("\n", index);
  const lineEnd = lineEndMatch < 0 ? text.length : lineEndMatch;
  const line = text.slice(lineStart, lineEnd);
  const previousEnd = Math.max(0, lineStart - 1);
  const previousStart = text.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
  const previousLine = text.slice(previousStart, previousEnd);
  const local = `${previousLine}\n${line}`;
  const normalized = normalize(line);
  const hasBotanicalComposition = /(?:flowers?|roses?|tulips?|orchids?|ورد|ورود|زهور|توليب|أوركيد)/i.test(text);
  const compositionHeading = /(?:includes?|contains?|composition|arrangement|components?|consists?\s+of|تتضمن|تتكون|تحتوي)\s*:?[ \t]*(?:\r?\n|$)/i.test(text);
  const physicalBullet = /^\s*[•*-]/.test(line)
    && !/(?:inspired|themed|motif|card|chocolate|gift|packaging|presentation|مستوحى|بطاقة|شوكولا|هدية|تغليف)/i.test(line);
  const dimensioned = /\d+(?:\.\d+)?\s*(?:cm|mm|m|in|inch|سم|ملم)/i.test(line);
  const packagingOrDeliveryProse = /(?:deliver(?:ed|y)?|ships?|packag(?:e|ed|ing)|presentation|presented|gift\s+box|comes?\s+in|توصيل|تغليف|علبة\s+هدية)/i.test(line);
  switch (format) {
    case "Flower Box":
      if (packagingOrDeliveryProse) return false;
      return /(?:flowers?|roses?|ورد|زهور).{0,35}(?:in|inside|arranged\s+in|داخل|في)\s+(?:a\s+)?(?:flower\s*)?(?:box|بوكس|صندوق)|(?:box|بوكس|صندوق).{0,50}(?:contains?|holds?|filled\s+with|arranged\s+with|فيه|يحتوي).{0,50}(?:flowers?|roses?|ورد|زهور)/i.test(line)
        || (/(?:flower\s*box|بوكس\s*(?:ورد|زهور)|صندوق\s*(?:ورد|زهور))\s+(?:includes?|contains?|composition|arrangement|تتضمن|تحتوي|تتكون)\s*:/i.test(line)
          && hasBotanicalComposition)
        || (compositionHeading && hasBotanicalComposition && physicalBullet && dimensioned);
    case "Hand Bouquet":
      return /hand(?:-|\s+)tied|ربط|تغليف\s+الباقة/i.test(local)
        || (/^\s*(?:bouquet|باقة\s+(?:ورد|زهور|يدوية))\s+(?:includes?|contains?|تتضمن|تحتوي)\s*:/i.test(line)
          && hasBotanicalComposition);
    case "Vase Arrangement":
      return /(?:flowers?|roses?|ورد|زهور).{0,35}(?:in|inside|arranged\s+in|داخل|في)\s+(?:a\s+)?(?:vase|مزهرية)|(?:vase|مزهرية)\s+(?:includes?|contains?|تتضمن|تحتوي)/i.test(line)
        || (compositionHeading && hasBotanicalComposition && physicalBullet && dimensioned);
    case "Flower Basket":
      return /(?:flowers?|roses?|ورد|زهور).{0,35}(?:in|inside|arranged\s+in|داخل|في)\s+(?:a\s+)?(?:basket|سلة)|(?:basket|سلة)\s+(?:includes?|contains?|تتضمن|تحتوي)/i.test(line)
        || (compositionHeading && hasBotanicalComposition && physicalBullet && dimensioned);
    case "Wooden Letter":
    case "Wooden Heart":
      return compositionHeading && hasBotanicalComposition && physicalBullet
        && (dimensioned || /\bwood(?:en)?\b|خشب/i.test(line));
    case "Balloon Product":
      return !/(?:inspired|themed|motif|card|مستوحى|بطاقة)/i.test(line)
        && (/(?:helium[-\s]+filled|foil\s+balloon|latex\s+balloon|بالون.{0,20}(?:هيليوم|فويل))/i.test(line)
          || (compositionHeading && physicalBullet && /(?:\b\d*\s*balloons?\b|بالونات?)/i.test(line)));
    case "Bundle":
      return /\bbundle\b|مجموعة|حزمة/.test(normalized);
    case "Single Gift Item":
      return /(?:gift|هدية)\s+(?:includes?|contains?|تتضمن|تحتوي)/i.test(line);
    default:
      return false;
  }
}

function approvedProductFormatMetadata(metadata: Record<string, unknown> | null | undefined): CanonicalProductFormat | null {
  if (!metadata || !(metadata.approved === true || metadata.confirmed === true || metadata.status === "approved")) return null;
  const value = metadata.productFormat ?? metadata.product_format ?? metadata.canonicalProductFormat;
  return typeof value === "string" && CANONICAL_PRODUCT_FORMATS.includes(value as CanonicalProductFormat)
    ? value as CanonicalProductFormat : null;
}

export function resolveProductFormat(
  product: Pick<SuggestionProduct, "name" | "description" | "descriptionAr" | "category" | "tags" | "metadata">,
): ProductFormatResolution {
  const observations: ProductFormatObservation[] = [];
  const sources = [
    { field: "name" as const, value: product.name, index: 0 },
    { field: "description" as const, value: product.description ?? "", index: 0 },
    { field: "descriptionAr" as const, value: product.descriptionAr ?? "", index: 0 },
    { field: "category" as const, value: product.category ?? "", index: 0 },
    ...(product.tags ?? []).map((value, index) => ({ field: "tag" as const, value, index })),
  ];
  for (const source of sources) {
    for (const definition of FORMAT_DEFINITIONS) {
      definition.pattern.lastIndex = 0;
      for (const match of source.value.matchAll(definition.pattern)) {
        let format = definition.format;
        let role = definition.role;
        const phrase = match[0];
        const genericBox = format === "Flower Box"
          && !/(?:flower|ورد|زهور)/i.test(phrase);
        if (genericBox && source.field !== "description" && source.field !== "descriptionAr") continue;
        if (/باقة/.test(phrase)) {
          const bouquetContext = /(?:ورد|زهور|يدوية|مربوطة|hand(?:-|\s+)tied)/i.test(source.value)
            || (source.field === "name" && /(?:bouquet|باقة\s+(?:ورد|زهور|يدوية))/i.test(source.value));
          if (!bouquetContext) format = "Bundle";
          else {
            format = "Hand Bouquet";
            role = "primary_arrangement_candidate";
          }
        }
        if (
          source.field === "name"
          && (format === "Hand Bouquet" || format === "Flower Basket")
          && !/(?:flowers?|roses?|tulips?|orchids?|sunflowers?|lilies?|peonies?|ورد|ورود|زهور|توليب|أوركيد|دوار\s+الشمس)/i.test(source.value)
        ) {
          continue;
        }
        const isDescription = source.field === "description" || source.field === "descriptionAr";
        const structural = isDescription && structurallyQualified(source.value, phrase, format, match.index ?? 0);
        if (isDescription && !structural) continue;
        const prefix = source.value.slice(Math.max(0, (match.index ?? 0) - 35), match.index ?? 0);
        if (format === "Balloon Product"
          && ((isDescription && (/(?:with|includes?|contains?)/i.test(source.value) || /[•*-]\s*\d*\s*$/.test(prefix)))
            || (source.field === "name" && /(?:with|and|includes?).{0,24}$/i.test(prefix)))) {
          role = "contained_component";
        }
        if (format === "Flower Box" && /(?:gift|packaging)\s+box|box\s+(?:gift|packaging)/i.test(source.value)) {
          role = "contained_component";
        }
        if (genericBox && role !== "contained_component") {
          const lineStart = source.value.lastIndexOf("\n", Math.max(0, (match.index ?? 0) - 1)) + 1;
          const nextBreak = source.value.indexOf("\n", match.index ?? 0);
          const line = source.value.slice(lineStart, nextBreak < 0 ? source.value.length : nextBreak);
          const explicitCarrierRelation =
            /(?:box|بوكس|صندوق).{0,50}(?:contains?|holds?|filled\s+with|arranged\s+with|فيه|يحتوي).{0,50}(?:flowers?|roses?|ورد|زهور)/i.test(line)
            || /(?:flowers?|roses?|ورد|زهور).{0,50}(?:in|inside|arranged\s+in|داخل|في).{0,20}(?:box|بوكس|صندوق)/i.test(line);
          const compositionSection = /(?:includes?|contains?|composition|arrangement|components?|consists?\s+of|تتضمن|تتكون|تحتوي)\s*:?[ \t]*(?:\r?\n|$)/i.test(source.value)
            && /(?:flowers?|roses?|ورد|زهور)/i.test(source.value)
            && /^\s*[•*-]/.test(line)
            && /\d+(?:\.\d+)?\s*(?:cm|mm|m|in|inch|سم|ملم)/i.test(line)
            && !/(?:gift|packaging|presentation|chocolate|هدية|تغليف)/i.test(line);
          if (!explicitCarrierRelation && !compositionSection) continue;
        }
        const strength = structural ? "structural"
          : source.field === "name" ? "name"
            : source.field === "category" || source.field === "tag" ? "weak" : "weak";
        observations.push({
          sourceField: source.field, sourceIndex: source.index,
          span: { start: match.index ?? 0, end: (match.index ?? 0) + phrase.length },
          phrase, canonicalFormat: format, strength, semanticRole: role,
          authorizing: strength === "structural" || strength === "name",
          participatesInResolution: true,
          rationale: structural ? "Structurally qualified composition or physical arrangement wording."
            : source.field === "name" ? "Explicit Product-name format evidence."
              : "Weak classification evidence; retained but not rule-authorizing.",
        });
      }
    }
  }
  const approvedFormat = approvedProductFormatMetadata(product.metadata);
  if (approvedFormat) observations.push({
    sourceField: "approved_metadata", sourceIndex: 0, span: { start: 0, end: approvedFormat.length },
    phrase: approvedFormat, canonicalFormat: approvedFormat, strength: "approved_metadata",
    semanticRole: approvedFormat === "Bundle" || approvedFormat === "Single Gift Item" ? "wrapper_commercial" : "primary_arrangement_candidate",
    authorizing: true, participatesInResolution: true,
    rationale: "Governed approved canonical Product-format metadata.",
  });
  const candidateMetadata = product.metadata?.candidateProductFormat ?? product.metadata?.candidate_product_format;
  if (typeof candidateMetadata === "string" && CANONICAL_PRODUCT_FORMATS.includes(candidateMetadata as CanonicalProductFormat)) {
    observations.push({
      sourceField: "diagnostic_metadata", sourceIndex: 0, span: { start: 0, end: candidateMetadata.length },
      phrase: candidateMetadata, canonicalFormat: candidateMetadata as CanonicalProductFormat, strength: "weak",
      semanticRole: "primary_arrangement_candidate", authorizing: false, participatesInResolution: false,
      rationale: "Candidate/unapproved metadata is diagnostic-only.",
    });
  }
  const rank = { structural: 4, name: 3, approved_metadata: 2, weak: 1 };
  const primary = observations.filter((item) => item.participatesInResolution && item.semanticRole === "primary_arrangement_candidate");
  const strongestByFormat = new Map<CanonicalProductFormat, ProductFormatObservation>();
  for (const item of primary) {
    const existing = strongestByFormat.get(item.canonicalFormat);
    if (!existing || rank[item.strength] > rank[existing.strength]) strongestByFormat.set(item.canonicalFormat, item);
  }
  const deduplicated = [...strongestByFormat.values()].map((item) => ({
    ...item,
    supportingObservations: primary.filter(({ canonicalFormat }) => canonicalFormat === item.canonicalFormat),
  }));
  const max = Math.max(0, ...deduplicated.map((item) => rank[item.strength]));
  const strongest = deduplicated.filter((item) => rank[item.strength] === max);
  const strongestFormats = [...new Set(strongest.map((item) => item.canonicalFormat))];
  const resolved = strongestFormats.length === 1 ? strongestFormats[0] : null;
  const authorizing = resolved == null ? null : observations.find((item) =>
    item.canonicalFormat === resolved && item.authorizing && item.semanticRole === "primary_arrangement_candidate");
  return {
    observations,
    deduplicatedResolutionEvidence: deduplicated,
    resolvedPrimaryFormat: resolved,
    authoritativePrimaryFormat: authorizing ? resolved : null,
    contextualRuleFormatEligible: !!authorizing,
    wrapperFormats: [...new Set(observations.filter((item) => item.semanticRole === "wrapper_commercial").map((item) => item.canonicalFormat))],
    disagreements: resolved == null ? [] : deduplicated.filter((item) => item.canonicalFormat !== resolved)
      .map((item) => ({ selected: resolved, conflicting: item.canonicalFormat, sourceField: item.sourceField, strength: item.strength })),
    unresolvedReason: strongestFormats.length > 1
      ? `Equal-strength incompatible product formats remain unresolved: ${strongestFormats.join(", ")}.`
      : primary.length === 0 ? "No qualifying primary arrangement evidence." : null,
  };
}

function singularize(value: string): string {
  if (value.endsWith("ies") && value.length > 3) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ises") && value.length > 4) return value.slice(0, -2);
  if (value.endsWith("uses") && !value.endsWith("ouses") && value.length > 4) return value.slice(0, -2);
  if (value.endsWith("oses") && value.length > 4) return value.slice(0, -1);
  if (/(ches|shes|xes|zes|sses)$/.test(value)) return value.slice(0, -2);
  if (
    value.endsWith("s")
    && !value.endsWith("ss")
    && !value.endsWith("is")
    && !value.endsWith("us")
    && value.length > 2
  ) {
    return value.slice(0, -1);
  }
  return value;
}

function matchingTokens(value: string | null | undefined): string[] {
  return normalize(value)
    .split(" ")
    .map(singularize)
    .filter((token) => token.length > 1 && !MATCH_STOP_WORDS.has(token));
}

function longestOrderedMatch(requiredTokens: string[], targetTokens: string[]): string[] {
  for (let length = requiredTokens.length; length > 0; length -= 1) {
    for (let requiredStart = 0; requiredStart <= requiredTokens.length - length; requiredStart += 1) {
      const requiredWindow = requiredTokens.slice(requiredStart, requiredStart + length);
      for (let targetStart = 0; targetStart <= targetTokens.length - length; targetStart += 1) {
        const targetWindow = targetTokens.slice(targetStart, targetStart + length);
        if (requiredWindow.every((token, index) => token === targetWindow[index])) {
          return requiredWindow;
        }
      }
    }
  }
  return [];
}

function tokens(value: string | null | undefined): Set<string> {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

function productText(product: Pick<SuggestionProduct, "name" | "description" | "descriptionAr" | "category" | "tags">): string {
  return normalize(
    [product.name, product.description, product.descriptionAr, product.category, ...(product.tags ?? [])].join(" "),
  );
}

function approvedAliases(item: RecipeLineInput): string[] {
  const aliases = item.metadata?.approvedAliases;
  return Array.isArray(aliases)
    ? aliases.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
}

export function productType(product: Pick<SuggestionProduct, "name" | "description" | "category">): string {
  const text = productText(product);
  const resolution = extractProductStructure(product).formatResolution;
  const format = resolution.resolvedPrimaryFormat;
  if (format === "Balloon Product") return "balloon";
  if (format === "Flower Box") return "box";
  if (format === "Hand Bouquet") return "bouquet";
  if (format === "Flower Basket") return "basket";
  if (format === "Vase Arrangement") return "vase";
  if (text.includes("plant")) return "plant";
  if (resolution.wrapperFormats.includes("Bundle")) return "bundle";
  return "other";
}

function similarity(
  target: Pick<SuggestionProduct, "name" | "description" | "category" | "tags">,
  candidate: SuggestionProduct,
): number {
  const targetTokens = tokens(productText(target));
  const candidateTokens = tokens(productText(candidate));
  if (targetTokens.size === 0 || candidateTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of targetTokens) if (candidateTokens.has(token)) intersection += 1;
  const union = new Set([...targetTokens, ...candidateTokens]).size;
  let score = intersection / union;
  if (productType(target) === productType(candidate)) score += 0.25;
  if (
    target.category &&
    candidate.category &&
    normalize(target.category) === normalize(candidate.category)
  ) {
    score += 0.2;
  }
  return Math.min(1, score);
}

function quantityNearMatch(text: string, name: string): number {
  const normalizedText = normalize(text);
  const targetWords = normalizedText.match(/[a-z0-9]+/g) ?? [];
  const requiredWords = matchingTokens(name);
  let matchStart = -1;

  for (let index = 0; index <= targetWords.length - requiredWords.length; index += 1) {
    const window = targetWords.slice(index, index + requiredWords.length).map(singularize);
    if (window.length === requiredWords.length && window.every((word, wordIndex) => word === requiredWords[wordIndex])) {
      matchStart = index;
      break;
    }
  }

  const prefix = matchStart >= 0
    ? targetWords.slice(Math.max(0, matchStart - 6), matchStart).join(" ")
    : normalizedText;
  const number = prefix.match(
    /(?:^|\s)(\d+(?:\.\d+)?)\s*(?:x\s*)?(?:(?:stems?|bunch(?:es)?|pieces?|units?|items?)\s*)?(?:of\s*)?$/,
  )?.[1];
  return number ? Number(number) : 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactCodeReference(text: string, code: string | null | undefined): boolean {
  const trimmedCode = String(code ?? "").trim();
  if (trimmedCode.length <= 2) return false;
  const pattern = new RegExp(
    `(?<![a-z0-9_-])${escapeRegExp(trimmedCode)}(?![a-z0-9_-])`,
    "i",
  );
  return pattern.test(text);
}

function addUnresolved(
  unresolvedLines: string[],
  unresolvedRequirements: RecipeSuggestion["unresolvedRequirements"],
  detail: RecipeSuggestion["unresolvedRequirements"][number],
): void {
  unresolvedLines.push(detail.requirement);
  unresolvedRequirements.push(detail);
}

function addLine(
  lines: Map<string, SuggestionLine>,
  line: SuggestionLine,
): void {
  const key = line.requirementId ?? `hidden:${line.hiddenRuleKey}:${line.baseItemId}`;
  const existing = lines.get(key);
  if (!existing) {
    lines.set(key, line);
    return;
  }
  // Deterministic rules outrank similar evidence, and explicit matches outrank
  // both. Quantities are additive only when the same source contributed twice.
  const rank: Record<RecipeEvidenceSource, number> = {
    deterministic_rule: 4,
    similar_product: 2,
    ai_assisted: 1,
    conflict: 0,
    unresolved: 0,
  };
  if (rank[line.source] > rank[existing.source]) {
    lines.set(key, line);
  } else if (line.source === existing.source && line.source === "similar_product") {
    existing.quantity = Math.max(existing.quantity, line.quantity);
  }
}

function findBaseItem(
  baseItems: RecipeLineInput[],
  terms: string[],
): RecipeLineInput | undefined {
  return baseItems.find((item) => {
    const itemText = normalize(`${item.baseItemName} ${item.baseItemCode ?? ""}`);
    return terms.every((term) => itemText.includes(normalize(term)));
  }) ?? baseItems.find((item) => {
    const itemText = normalize(`${item.baseItemName} ${item.baseItemCode ?? ""}`);
    return terms.some((term) => itemText.includes(normalize(term)));
  });
}

function approvedMetadata(item: RecipeLineInput): boolean {
  const metadata = item.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  return metadata.confirmed === true || metadata.approved === true || metadata.status === "approved";
}

const COMPATIBILITY_COLORS = [
  "red", "white", "pink", "yellow", "purple", "orange", "blue", "green",
  "black", "gold", "silver", "fuchsia", "lilac", "peach", "coral",
  "burgundy", "ivory",
] as const;
const DIMENSION_LABELS = ["height", "width", "length", "diameter", "depth"] as const;
/** Maximum approved conversion/rounding tolerance; never merges variants. */
const DIMENSION_TOLERANCE_CM = 0.1;

function canonicalValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = normalize(value);
  const translations: Record<string, string> = {
    "أحمر": "red", "حمراء": "red", "أبيض": "white", "ابيض": "white", "بيضاء": "white",
    "وردي": "pink", "وردية": "pink", "أصفر": "yellow", "صفراء": "yellow",
    "بنفسجي": "purple", "بنفسجية": "purple", "برتقالي": "orange", "برتقالية": "orange",
    "أزرق": "blue", "زرقاء": "blue", "أخضر": "green", "خضراء": "green",
    "أسود": "black", "سوداء": "black", "ذهبي": "gold", "فضي": "silver",
  };
  return translations[normalized] ?? singularize(normalized);
}

function botanicalIdentity(value: string): { family: string | null; variety: string | null } {
  const text = normalize(value);
  const definitions: Array<[RegExp, string, string | null]> = [
    [/\bcherry brandy roses?\b/, "rose", "cherry brandy"],
    [/\bspray roses?\b/, "rose", "spray"],
    [/\bbaby roses?\b/, "rose", "baby"],
    [/\benglish roses?\b/, "rose", "english"],
    [/\bcalla (?:lily|lilies)\b/, "lily", "calla"],
    [/\broses?\b|ورد|ورود/, "rose", null],
    [/\blil(?:y|ies)\b/, "lily", null],
    [/\btulips?\b|توليب/, "tulip", null],
    [/\b(?:iris|irises)\b|سوسن/, "iris", null],
    [/\borchids?\b|أوركيد/, "orchid", null],
  ];
  for (const [pattern, family, variety] of definitions) if (pattern.test(text)) return { family, variety };
  const component = extractRecipeRequirements({ name: value }).find(({ subtype }) => subtype === "botanical");
  if (!component) return { family: null, variety: null };
  const words = matchingTokens(component.phrase).filter((token) => !COMPATIBILITY_COLORS.includes(token as typeof COMPATIBILITY_COLORS[number]));
  return { family: words.at(-1) ?? null, variety: words.length > 1 ? words.slice(0, -1).join(" ") : null };
}

function containerIdentity(value: string): string | null {
  return normalize(value).match(/\b(box|boxes|vase|vases|basket|baskets)\b/)?.[1]
    ?.replace(/boxes$/, "box").replace(/es$/, "").replace(/s$/, "") ?? null;
}

function attributeEvidenceFromText(
  text: string,
  source: CandidateAttributeEvidence["source"],
): Record<string, CandidateAttributeEvidence[]> {
  const structure = extractProductStructure({ name: text });
  const result: Record<string, CandidateAttributeEvidence[]> = {};
  const add = (key: string, value: unknown, phrase = text) => {
    if (value == null || value === "") return;
    (result[key] ??= []).push({ value, source, sourcePhrase: phrase });
  };
  const botanical = botanicalIdentity(text);
  const recognized = extractRecipeRequirements({ name: text })
    .map(({ subtype }) => subtype)
    .filter((value): value is string => !!value && value !== "catalog_reference");
  if (botanical.family) add("componentType", "botanical");
  else if (/^\s*helium\b/i.test(text)) add("componentType", "helium_fill");
  else if (recognized.length === 1) add("componentType", recognized[0]);
  else if (/\bballoons?\b/i.test(text)) add("componentType", "balloon");
  add("ingredientFamily", botanical.family);
  if (botanical.family) add("botanicalVariety", botanical.variety ?? "generic");
  const structuredColor = canonicalValue(structure.color.value);
  if (structuredColor) add("color", structuredColor);
  for (const color of COMPATIBILITY_COLORS) {
    if (color !== structuredColor && new RegExp(`\\b${color}\\b`, "i").test(text)) add("color", color);
  }
  add("container", containerIdentity(text));
  add("shape", canonicalValue(structure.shape.value));
  add("material", canonicalValue(structure.material.value));
  const balloonType = normalize(text).match(/\b(foil|latex|physical)\s+balloons?\b/)?.[1];
  add("balloonType", balloonType);
  if (/\bhelium\b/i.test(text)) add("fill", "helium");
  const dimensions = structure.dimensions;
  for (const label of DIMENSION_LABELS) {
    const match = text.match(new RegExp(`\\b${label}\\s*[:=]?\\s*[\\d.]+\\s*(?:cm|mm|m|in|inch|inches)`, "i"))
      ?? text.match(new RegExp(`[\\d.]+\\s*(?:cm|mm|m|in|inch|inches)\\s*${label}\\b`, "i"));
    if (match) {
      const parsed = extractProductStructure({ name: match[0] }).dimensions[0];
      if (parsed) add(label, parsed.centimeters, match[0]);
    }
  }
  if (botanical.family && dimensions.length === 1) add("stemLength", dimensions[0].centimeters, dimensions[0].sourcePhrase);
  if (/\b(?:balloons?|helium)\b/i.test(text) && dimensions.length === 1) add("balloonSize", dimensions[0].centimeters, dimensions[0].sourcePhrase);
  const packageMatch = text.match(/\b(?:pack(?:age)?\s+of\s+(\d+)|(\d+)\s*[- ]pack)\b/i);
  if (packageMatch) add("packageSize", Number(packageMatch[1] ?? packageMatch[2]), packageMatch[0]);
  return result;
}

function mergeAttributeEvidence(
  target: Record<string, CandidateAttributeEvidence[]>,
  source: Record<string, CandidateAttributeEvidence[]>,
): void {
  for (const [key, values] of Object.entries(source)) (target[key] ??= []).push(...values);
}

function candidateProfile(item: RecipeLineInput): Record<string, CandidateAttributeEvidence[]> {
  const attributes = attributeEvidenceFromText(item.baseItemName, "canonical_name");
  const metadata = item.metadata ?? {};
  if (metadata.governedPackageFacts === true) {
    const packageSizeKey = ["packageSize", "package_size", "packageCount", "package_count"]
      .find((key) => metadata[key] != null);
    const packageSize = packageSizeKey == null ? NaN : Number(metadata[packageSizeKey]);
    if (packageSizeKey != null && Number.isFinite(packageSize)) {
      (attributes.packageSize ??= []).push({
        value: packageSize,
        source: "governed_package",
        sourcePhrase: `${packageSizeKey}: ${String(metadata[packageSizeKey])}`,
      });
    }
  }
  if (approvedMetadata(item)) {
    const mappings: Record<string, string[]> = {
      ingredientFamily: ["ingredientFamily", "ingredient_family", "flowerType", "flower_type", "type"],
      botanicalVariety: ["botanicalVariety", "botanical_variety", "variety", "subtype"],
      color: ["color", "colour"],
      stemLength: ["stemLengthCm", "stem_length_cm", "stemLength", "stem_length"],
      container: ["container", "containerType", "container_type"],
      shape: ["shape"], material: ["material"],
      packageSize: ["packageSize", "package_size", "packageCount", "package_count"],
      balloonType: ["balloonType", "balloon_type"], balloonSize: ["balloonSizeCm", "balloon_size_cm"],
      fill: ["fill", "gas"],
      height: ["heightCm", "height_cm"], width: ["widthCm", "width_cm"],
      length: ["lengthCm", "length_cm"], diameter: ["diameterCm", "diameter_cm"], depth: ["depthCm", "depth_cm"],
    };
    for (const [attribute, keys] of Object.entries(mappings)) {
      if (attribute === "packageSize" && metadata.governedPackageFacts === true) continue;
      const key = keys.find((candidate) => metadata[candidate] != null);
      if (!key) continue;
      const raw = metadata[key];
      const numeric = ["stemLength", "packageSize", "balloonSize", ...DIMENSION_LABELS].includes(attribute);
      let value: unknown;
      if (numeric) {
        if (attribute === "packageSize") value = Number(raw);
        else if (typeof raw === "object" && raw !== null && "centimeters" in raw) {
          value = Number((raw as { centimeters: unknown }).centimeters);
        } else if (typeof raw === "string" && /(?:cm|mm|m|in|inch|inches)\b/i.test(raw)) {
          value = extractProductStructure({ name: raw }).dimensions[0]?.centimeters;
        } else {
          value = Number(raw);
        }
      } else if (attribute === "ingredientFamily" || attribute === "botanicalVariety") {
        const botanical = botanicalIdentity(String(raw));
        value = attribute === "ingredientFamily"
          ? botanical.family ?? canonicalValue(raw)
          : botanical.variety ?? canonicalValue(raw);
      } else {
        value = canonicalValue(raw);
      }
      if (value == null || (numeric && !Number.isFinite(value))) continue;
      (attributes[attribute] ??= []).push({
        value,
        source: "approved_metadata",
        sourcePhrase: `${key}: ${String(raw)}`,
      });
    }
    const dimensions = metadata.dimensions;
    if (dimensions && typeof dimensions === "object" && !Array.isArray(dimensions)) {
      for (const label of DIMENSION_LABELS) {
        const raw = (dimensions as Record<string, unknown>)[label];
        if (raw == null) continue;
        const centimeters = typeof raw === "object" && raw !== null && "centimeters" in raw
          ? Number((raw as { centimeters: unknown }).centimeters)
          : typeof raw === "string"
            ? extractProductStructure({ name: raw }).dimensions[0]?.centimeters
            : Number(raw);
        if (centimeters != null && Number.isFinite(centimeters)) {
          (attributes[label] ??= []).push({
            value: centimeters,
            source: "approved_metadata",
            sourcePhrase: `dimensions.${label}: ${String(raw)}`,
          });
        }
      }
    }
  }
  for (const alias of approvedAliases(item)) {
    mergeAttributeEvidence(attributes, attributeEvidenceFromText(alias, "approved_alias"));
  }
  return attributes;
}

function requirementDiscriminators(requirement: RecipeRequirement): Record<string, unknown> {
  if (requirement.subtype === "catalog_reference") return {};
  const result: Record<string, unknown> = {};
  if (requirement.subtype) result.componentType = requirement.subtype;
  const botanical = botanicalIdentity(requirement.phrase);
  if (requirement.subtype === "botanical") {
    if (botanical.family) result.ingredientFamily = botanical.family;
    if (botanical.family) result.botanicalVariety = botanical.variety ?? "generic";
  }
  if (requirement.subtype === "container") {
    const container = containerIdentity(requirement.phrase);
    if (container) result.container = container;
  }
  for (const key of ["color", "shape", "material", "fill", "balloonType"] as const) {
    if (key === "balloonType" && requirement.subtype === "helium_fill") continue;
    if ((key === "shape" || key === "material") && requirement.subtype !== "container") continue;
    if (key === "fill" && requirement.subtype !== "helium_fill") continue;
    if (requirement.attributes[key] != null) result[key] = canonicalValue(requirement.attributes[key]) ?? requirement.attributes[key];
  }
  const stem = requirement.attributes.stemLength as NumericDimension | undefined;
  if (stem?.centimeters != null) result.stemLength = stem.centimeters;
  for (const label of DIMENSION_LABELS) {
    const dimension = requirement.attributes[label] as NumericDimension | undefined;
    if (dimension?.centimeters != null) result[label] = dimension.centimeters;
  }
  const dimension = Number(requirement.attributes.dimensionCentimeters);
  if (Number.isFinite(dimension) && (requirement.subtype === "balloon" || requirement.subtype === "helium_fill")) {
    result.balloonSize = dimension;
  }
  const pack = requirement.phrase.match(/\b(?:pack(?:age)?\s+of\s+(\d+)|(\d+)\s*[- ]pack)\b/i);
  if (requirement.attributes.packageSize != null) result.packageSize = Number(requirement.attributes.packageSize);
  else if (pack) result.packageSize = Number(pack[1] ?? pack[2]);
  return result;
}

function compareCandidate(
  requirement: RecipeRequirement,
  item: RecipeLineInput,
): CandidateCompatibilityDiagnostic {
  const attributes = candidateProfile(item);
  const required = requirementDiscriminators(requirement);
  const comparisons: CandidateCompatibilityDiagnostic["comparisons"] = {};
  const hardExclusions: string[] = [];
  let hasUnknownExplicitDiscriminator = false;
  for (const [key, requiredValue] of Object.entries(required)) {
    const evidenceValues = attributes[key] ?? [];
    const authoritative = evidenceValues.filter(({ source }) =>
      source === "canonical_name" || source === "approved_metadata" || source === "governed_package",
    );
    // Aliases are retrieval aids only. They can establish an attribute only
    // when authoritative catalog/approved facts are absent, and never hide a
    // conflicting canonical or approved-metadata value.
    const evaluated = authoritative.length > 0 ? authoritative : evidenceValues;
    const values = [...new Set(evaluated.map(({ value }) => value))];
    const numeric = typeof requiredValue === "number";
    const agrees = (value: unknown) => numeric
      ? typeof value === "number" && Math.abs(value - requiredValue) <= DIMENSION_TOLERANCE_CM
      : canonicalValue(value) === canonicalValue(requiredValue);
    let state: CompatibilityState;
    if (values.length === 0) state = "unknown";
    else if (values.some((value) => !agrees(value))) state = "incompatible";
    else state = "compatible";
    comparisons[key] = {
      state,
      required: requiredValue,
      candidate: [...new Set(evidenceValues.map(({ value }) => value))],
      sources: evidenceValues,
    };
    if (state === "incompatible") hardExclusions.push(`${key}: required ${String(requiredValue)}, candidate ${values.join(", ")}`);
    if (state === "unknown") hasUnknownExplicitDiscriminator = true;
  }
  return {
    baseItemId: item.baseItemId,
    attributes,
    comparisons,
    hardExclusions,
    hasUnknownExplicitDiscriminator,
    survivor: hardExclusions.length === 0,
  };
}

/** Current governed #4939 compatibility evaluation for review/approval boundaries. */
export function evaluateCandidateCompatibility(
  requirement: RecipeRequirement,
  item: RecipeLineInput,
): CandidateCompatibilityDiagnostic {
  return compareCandidate(requirement, item);
}

function lexicallyRelated(requirement: RecipeRequirement, item: RecipeLineInput): boolean {
  if (requirement.subtype === "catalog_reference") {
    return hasExactCodeReference(requirement.phrase, item.baseItemCode)
      && normalize(item.baseItemCode) === normalize(requirement.phrase);
  }
  const requirementTokens = matchingTokens(requirement.phrase);
  return [item.baseItemName, ...approvedAliases(item)].some((term) => {
    const itemTokens = matchingTokens(term);
    const overlap = longestOrderedMatch(requirementTokens, itemTokens);
    if (overlap.length === requirementTokens.length) return true;
    const requiredBotanical = botanicalIdentity(requirement.phrase);
    const candidateBotanical = botanicalIdentity(term);
    if (requirement.subtype === "botanical" && requiredBotanical.family && requiredBotanical.family === candidateBotanical.family) return true;
    if (requirement.subtype === "container") return containerIdentity(requirement.phrase) === containerIdentity(term);
    if (requirement.subtype === "balloon" || requirement.subtype === "helium_fill") {
      return /\bballoon|helium\b/i.test(term);
    }
    return false;
  });
}

function governedTrustedStemLength(item: RecipeLineInput): number | null {
  const canonicalDimensions = extractProductStructure({ name: item.baseItemName }).dimensions;
  // Canonical ambiguity is authoritative and cannot be repaired by metadata or
  // an alias. A resolver must establish one, not merely a plausible, length.
  if (canonicalDimensions.length > 1) return null;
  const trustedStem = (candidateProfile(item).stemLength ?? [])
    .filter(({ source }) => source === "canonical_name" || source === "approved_metadata")
    .map(({ value }) => value)
    .filter((value): value is number => typeof value === "number");
  // Contextual rules require one corroborated authoritative fact. Canonical
  // and approved metadata disagreement is unsafe even though canonical has
  // ordinary matching precedence; aliases never participate here.
  return new Set(trustedStem).size === 1 ? trustedStem[0] ?? null : null;
}

function contextualRoseVariant(
  target: RecipeSuggestionTarget,
  requirement: RecipeRequirement,
  candidates: Array<{ item: RecipeLineInput; diagnostic: CandidateCompatibilityDiagnostic }>,
  approvedRules: readonly ApprovedContextualRule[],
): { item: RecipeLineInput; stemLengthCm: number; rule: ApprovedContextualRule } | null {
  // This resolver governs only an otherwise missing stem length. It must not
  // override an explicit requested length or any other unknown/contradiction.
  if (requirementDiscriminators(requirement).stemLength != null) return null;
  const structure = extractProductStructure(target);
  if (!structure.formatResolution.contextualRuleFormatEligible
    || structure.formatResolution.authoritativePrimaryFormat == null) return null;
  const requiredFamily = botanicalIdentity(requirement.phrase).family;
  const requiredColor = canonicalValue(requirement.attributes.color);
  const applicableRules = approvedRules.filter((rule) =>
    rule.canonicalFormats.includes(structure.formatResolution.authoritativePrimaryFormat!)
    && (!rule.ingredientFamily || requiredFamily === singularize(rule.ingredientFamily.toLowerCase()))
    && (!rule.color || requiredColor === canonicalValue(rule.color))
    && rule.stemLengthCm != null,
  );
  if (applicableRules.length === 0) return null;
  const approvedById = new Map(applicableRules.map((rule) => [rule.resolverBaseItemId, rule]));
  const roseCandidates = candidates.filter(({ item, diagnostic }) =>
    approvedById.has(item.baseItemId)
    && diagnostic.survivor
    && Object.entries(diagnostic.comparisons)
      .filter(([key]) => key !== "stemLength")
      .every(([, comparison]) => comparison.state === "compatible")
    && /\bred\s+roses?\b/i.test(item.baseItemName),
  );
  if (roseCandidates.length === 0) return null;
  const matches = roseCandidates.flatMap(({ item }) => {
    const stemLengthCm = governedTrustedStemLength(item);
    const rule = approvedById.get(item.baseItemId);
    return stemLengthCm !== null
      && rule?.stemLengthCm != null
      && Math.abs(stemLengthCm - rule.stemLengthCm) <= DIMENSION_TOLERANCE_CM
      ? [{ item, stemLengthCm, rule }]
      : [];
  });
  // A single approved exact variant is required.  In particular, no 50cm
  // fallback exists, and a missing/reversed/multiple dimension is not inferred.
  return matches.length === 1 ? matches[0] : null;
}

function applyOperationalRules(
  target: RecipeSuggestionTarget,
  baseItems: RecipeLineInput[],
  requirements: readonly RecipeRequirement[],
  lines: Map<string, SuggestionLine>,
  unresolved: string[],
  unresolvedRequirements: RecipeSuggestion["unresolvedRequirements"],
  activeRules: OperationalRuleActivation,
): void {
  const text = productText(target);
  const format = extractProductStructure(target).formatResolution;

  const totalBalloons = requirements
    .filter(({ subtype }) => subtype === "balloon")
    .reduce((sum, requirement) => sum + requirement.quantity, 0);
  if (activeRules.balloonMetalRing && totalBalloons > 0) {
    const ring = findBaseItem(baseItems, ["metal", "ring"]);
    if (ring) {
      addLine(lines, {
        ...ring,
        quantity: totalBalloons,
        source: "deterministic_rule",
        confidence: "high",
        reason: "Confirmed rule: one metal ring per physical balloon.",
        hiddenRuleKey: "balloon_metal_ring",
        unresolved: false,
        requirementId: null,
        requirementEvidence: null,
      });
    } else {
      addUnresolved(unresolved, unresolvedRequirements, {
        requirementId: "operational:balloon-metal-ring",
        requirement: "Metal Ring (confirmed balloon rule; no matching Base Item exists)",
        quantity: totalBalloons,
        reason: "A confirmed balloon packaging rule could not be matched to an existing Base Item.",
      });
    }
  }

  const boxSize =
    text.includes("extra large") || text.includes("xl")
      ? "extra_large"
      : text.includes("large")
        ? "large"
        : text.includes("medium")
          ? "medium"
          : null;
  const isRoundBox = text.includes("round") && text.includes("box");
  const isHeartBox = text.includes("heart") && text.includes("box");
  if (activeRules.flowerBoxSponge
    && format.contextualRuleFormatEligible
    && format.authoritativePrimaryFormat === "Flower Box"
    && boxSize && (isRoundBox || isHeartBox)) {
    const spongeQuantity =
      isRoundBox && boxSize === "medium" ? 1
        : isRoundBox && boxSize === "large" ? 2
          : isRoundBox && boxSize === "extra_large" ? 3
            : isHeartBox && boxSize === "medium" ? 1
              : isHeartBox && boxSize === "extra_large" ? 5
                : null;
    const sponge = findBaseItem(baseItems, ["sponge"]);
    if (spongeQuantity !== null && sponge) {
      addLine(lines, {
        ...sponge,
        quantity: spongeQuantity,
        source: "deterministic_rule",
        confidence: "high",
        reason: `Confirmed ${isRoundBox ? "round" : "heart"} flower-box rule for ${boxSize.replace("_", " ")} size.`,
        hiddenRuleKey: `flower_box_${isRoundBox ? "round" : "heart"}_${boxSize}_sponge`,
        unresolved: false,
        requirementId: null,
        requirementEvidence: null,
      });
    } else if (spongeQuantity === null) {
      addUnresolved(unresolved, unresolvedRequirements, {
        requirementId: "operational:flower-box-packaging-review",
        requirement: "Packaging rule requires review",
        quantity: 1,
        reason: "The product size does not map to a confirmed packaging quantity.",
      });
    } else {
      addUnresolved(unresolved, unresolvedRequirements, {
        requirementId: "operational:flower-box-sponge",
        requirement: "Floral Sponge (confirmed packaging rule; no matching Base Item exists)",
        quantity: spongeQuantity,
        reason: "A confirmed flower-box packaging rule could not be matched to an existing Base Item.",
      });
    }
  }
}

const BOTANICAL_MODIFIER_PATTERNS = [
  "cherry\\s+brandy",
  "extra\\s+large",
  "sweet",
  "dried",
  "pink",
  "red",
  "white",
  "yellow",
  "purple",
  "orange",
  "blue",
  "green",
  "black",
  "fuchsia",
  "lilac",
  "peach",
  "coral",
  "burgundy",
  "ivory",
  "spray",
  "baby",
] as const;

/**
 * This is intentionally a centralized vocabulary rather than a collection of
 * one-off regular expressions.  The terms are semantic component families
 * found in the Presentail catalog; modifiers remain part of the extracted
 * phrase so candidate matching can respect color/variety when it is supplied.
 */
const BOTANICAL_FAMILY_PATTERNS = [
  "english\\s+roses?",
  "hawthorn\\s+berr(?:y|ies)",
  "copper\\s+beech\\s+leaves?",
  "dendrobiums?",
  "burnet\\s+flowers?",
  "oak\\s+leaves?",
  "astilbes?",
  "carthamus",
  "calla\\s+lil(?:y|ies)",
  "spray\\s+roses?",
  "baby\\s+roses?",
  "green\\s+mist",
  "globe\\s+amaranth",
  "lil(?:y|ies)",
  "lili(?:um|ums)",
  "roses?",
  "tulips?",
  "irises?",
  "orchids?",
  "ranunculus",
  "ruscus",
  "eucalyptus",
  "carnations?",
  "chrysanthemums?",
  "gerberas?",
  "hypericum",
  "gypsophila",
  "dahlias?",
  "matthiola",
  "eustoma",
  "limonium",
  "solidago",
  "sunflowers?",
  "hydrangeas?",
  "anthuriums?",
  "delphiniums?",
  "celosias?",
  "statice",
  "daisies?",
  "amaranthus",
  "snapdragons?",
  "trachelium",
  "asparagus",
  "eryngium",
  "proteas?",
  "chamomile",
  "anemones?",
  "freesias?",
  "peonies?",
  "alstroemerias?",
  "lisianthus",
  "flowers?",
  "greenery",
] as const;

const BOTANICAL_PHRASE_PATTERN = [
  `(?:(?:(?:${BOTANICAL_MODIFIER_PATTERNS.join("|")})(?:\\s+(?:${BOTANICAL_MODIFIER_PATTERNS.join("|")}))*)(?:\\s*/\\s*(?:(?:${BOTANICAL_MODIFIER_PATTERNS.join("|")})(?:\\s+(?:${BOTANICAL_MODIFIER_PATTERNS.join("|")}))*))*\\s+)?`,
  `(?:${BOTANICAL_FAMILY_PATTERNS.join("|")})`,
].join("");

function botanicalPattern(): RegExp {
  return new RegExp(
    `\\b(?:(\\d+(?:\\.\\d+)?|half|a|an)\\s*(stems?|bunch(?:es)?|pieces?|units?|items?|packs?|pack)?\\s*(?:of\\s+)?(?:premium\\s+)?)?((?:${BOTANICAL_PHRASE_PATTERN}))\\b`,
    "gi",
  );
}

const GIFT_PRODUCT_FAMILY_PATTERNS = [
  "shampoos?",
  "shower\\s+gels?",
  "conditioners?",
  "body\\s+lotions?",
  "body\\s+mists?",
  "hand\\s+wash(?:es)?",
  "essential\\s+oils?",
  "hair\\s+mists?",
  "soap\\s+bars?",
] as const;

function giftProductPattern(): RegExp {
  const qualifier = "(?:lavender\\s+and\\s+olive\\s+oil|rose\\s+and\\s+oud|lavender|pure\\s+jasmine)";
  return new RegExp(
    `\\b(?:(\\d+(?:\\.\\d+)?)\\s*(pieces?|units?|items?)?\\s*(?:of\\s+)?)?((?:${qualifier}\\s+)?(?:${GIFT_PRODUCT_FAMILY_PATTERNS.join("|")}))\\b`,
    "gi",
  );
}

const SUPPORTED_COMPONENTS: Array<{
  pattern: RegExp;
  kind: RecipeRequirementKind;
  subtype: string;
  category: string;
}> = [
  { pattern: /\b([A-Z]{3,}(?:-[A-Z0-9]+)+)\b/g, kind: "component", subtype: "catalog_reference", category: "catalog_reference" },
  { pattern: botanicalPattern(), kind: "ingredient", subtype: "botanical", category: "flowers_greenery" },
  { pattern: /(?<![\u0600-\u06ff])(?:(\d+(?:\.\d+)?)\s*(سيقان?|ساق|قطع?)?\s*(?:من\s+)?)?((?:ورد(?:ة|ات)?|ورود|زهور|توليب|سوسن|أوركيد))(?![\u0600-\u06ff])/gi, kind: "ingredient", subtype: "botanical", category: "flowers_greenery" },
  { pattern: /\b(?:(\d+(?:\.\d+)?)\s*)?((?:(?:white|black|red|pink|small|medium|large|extra large|xl|round|heart(?:-shaped)?|square|rectangular|wooden|glass|ceramic)\s+)*(?:flower\s+)?(?:box(?:es)?|vases?|baskets?))\b/gi, kind: "container", subtype: "container", category: "container" },
  { pattern: /\b(?:(\d+(?:\.\d+)?)\s*(pieces?|sheets?|rolls?)?\s*(?:of\s+)?)?((?:(?:elegant\s+)?(?:white|black|kraft|clear|colored|coloured)\s+(?:wrapping\s+)?paper)|(?:wrapping\s+paper)|(?:tissue\s+paper))\b/gi, kind: "component", subtype: "wrapping_paper", category: "packaging" },
  { pattern: /(?<![\w-])(?:(\d+(?:\.\d+)?)\s*(pieces?|rolls?)?\s*(?:of\s+)?)?((?:(?:soft|satin|white|black|red|pink|gold|silver)\s+)?ribbons?)\b/gi, kind: "component", subtype: "ribbon", category: "packaging" },
  { pattern: /\b(?:(\d+(?:\.\d+)?)\s*)?((?:(?:latex|foil|physical|helium[-\s]+filled)\s+)*balloons?)\b/gi, kind: "component", subtype: "balloon", category: "balloon" },
  { pattern: /\b(?:(\d+(?:\.\d+)?)\s*)?((?:helium[-\s]+filled|filled\s+with\s+helium))\b/gi, kind: "component", subtype: "helium_fill", category: "balloon" },
  { pattern: /\b(?:(\d+(?:\.\d+)?)\s*)?((?:(?:birthday|chocolate|vanilla|custom)\s+)?cakes?)\b/gi, kind: "component", subtype: "cake", category: "food" },
  { pattern: /\b(?:(\d+(?:\.\d+)?)\s*)?((?:(?:chocolate|teddy|perfume|candle|mug|product)\s+)?gifts?)\b/gi, kind: "component", subtype: "gift", category: "gift" },
  { pattern: /\b(?:(\d+(?:\.\d+)?)\s*)?((?:chocolates?|teddy\s+bears?|perfumes?|candles?|mugs?))\b/gi, kind: "component", subtype: "product", category: "gift" },
  { pattern: giftProductPattern(), kind: "component", subtype: "product", category: "gift" },
  { pattern: /\b(?:(\d+(?:\.\d+)?)\s*)?((?:gift\s+bag|paper\s+bag|packaging\s+box|cake\s+box|cellophane|floral\s+tape))\b/gi, kind: "component", subtype: "packaging", category: "packaging" },
];

/** Shared current-main subtype policy for reviewer-supplied classifications. */
export function isSupportedRecipeRequirementSubtype(
  kind: RecipeRequirementKind,
  subtype: unknown,
): subtype is string {
  return typeof subtype === "string"
    && SUPPORTED_COMPONENTS.some((component) => component.kind === kind && component.subtype === subtype);
}

function stableRequirementId(evidenceValue: RecipeRequirementEvidence): string {
  const input = [
    evidenceValue.sourceField,
    evidenceValue.sourceIndex,
    evidenceValue.lineIndex,
    evidenceValue.componentIndex,
    evidenceValue.occurrence,
    evidenceValue.normalizedPhrase,
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `req_${(hash >>> 0).toString(36)}`;
}

type ExtractedRequirement = {
  requirement: RecipeRequirement;
  compositionScore: number;
  explicitQuantity: boolean;
};

function parseRequirementQuantity(raw: string | undefined): number {
  if (!raw) return 1;
  if (raw.toLowerCase() === "half") return 0.5;
  if (raw.toLowerCase() === "a" || raw.toLowerCase() === "an") return 1;
  return Number(raw);
}

function hasDescriptionCompositionContext(
  line: string,
  exactPhrase: string,
  matchStart: number,
  quantityRaw: string | undefined,
): number {
  const trimmed = line.trim();
  if (/^(?:[•*\-–—]|\d+[.)])\s*/.test(trimmed)) return 3;
  if (/\b(?:includes?|contains?|featur(?:es|ing)|comprises?|consists?\s+of|wrapped\s+in)\b/i.test(line)) return 3;
  if (quantityRaw && /^\d/.test(quantityRaw.trim())) return 3;
  if (/\b(?:helium[-\s]+filled|\d+(?:\.\d+)?\s*(?:inch|inches|in|cm|mm))\b/i.test(line)) return 2;
  // A line containing only a concrete component and physical specifications
  // is a composition entry even without a bullet marker.
  const before = line.slice(0, matchStart).trim();
  const after = line.slice(matchStart + exactPhrase.length).trim();
  if (
    before.length === 0
    && (after.length === 0 || /^[\d\s.,×x+\-/:]*(?:cm|mm|m|in|inch|inches|height|diameter|tall|wide)?[\d\s.,×x+\-/:]*$/i.test(after))
  ) {
    return 2;
  }
  return 0;
}

function requirementAttributes(exactPhrase: string, semanticClause: string): Record<string, unknown> {
  const phraseStructure = extractProductStructure({ name: exactPhrase });
  const clauseStructure = extractProductStructure({ name: semanticClause });
  const attributes: Record<string, unknown> = {};
  if (clauseStructure.color.value ?? phraseStructure.color.value) {
    attributes.color = clauseStructure.color.value ?? phraseStructure.color.value;
  }
  if (clauseStructure.material.value ?? phraseStructure.material.value) {
    attributes.material = clauseStructure.material.value ?? phraseStructure.material.value;
  }
  if (clauseStructure.shape.value ?? phraseStructure.shape.value) {
    attributes.shape = clauseStructure.shape.value ?? phraseStructure.shape.value;
  }
  if (/\bhelium[-\s]+filled\b/i.test(semanticClause)) attributes.fill = "helium";
  if (clauseStructure.dimensions.length > 0) {
    attributes.dimensions = clauseStructure.dimensions;
    if (clauseStructure.dimensions.length === 1) {
      attributes.dimensionCentimeters = clauseStructure.dimensions[0].centimeters;
    }
    for (const dimension of clauseStructure.dimensions) {
      const dimensionPattern = escapeRegExp(dimension.sourcePhrase).replace(/\s+/g, "\\s+");
      const labels = "stem\\s+length|height|width|length|diameter|depth";
      const labelMatch = semanticClause.match(new RegExp(`\\b(${labels})\\s*[:=]?\\s*${dimensionPattern}`, "i"))
        ?? semanticClause.match(new RegExp(`${dimensionPattern}\\s*(?:[,;:()\\s×x-])*(${labels})\\b`, "i"));
      const normalizedLabel = labelMatch?.[1]?.toLowerCase().replace(/\s+/g, "");
      const label = normalizedLabel === "stemlength"
        ? "stemLength"
        : normalizedLabel as "height" | "width" | "length" | "diameter" | "depth" | undefined;
      if (label) attributes[label] = dimension;
    }
  }
  if (clauseStructure.stemLength.value) attributes.stemLength = clauseStructure.stemLength.value;
  return attributes;
}

function compatibleRequirementAttributes(a: RecipeRequirement, b: RecipeRequirement): boolean {
  for (const attribute of ["color", "material", "shape"] as const) {
    const aValue = a.attributes[attribute];
    const bValue = b.attributes[attribute];
    const canonicalAttribute = (value: string): string => {
      const normalized = normalize(value);
      if (/^(?:red|أحمر|حمراء)$/.test(normalized)) return "red";
      if (/^(?:white|ابيض|أبيض|بيضاء)$/.test(normalized)) return "white";
      if (/^(?:pink|وردي|وردية)$/.test(normalized)) return "pink";
      if (/^(?:orange|برتقالي|برتقالية)$/.test(normalized)) return "orange";
      if (/^(?:yellow|أصفر|صفراء)$/.test(normalized)) return "yellow";
      if (/^(?:purple|بنفسجي|بنفسجية)$/.test(normalized)) return "purple";
      if (/^(?:blue|أزرق|زرقاء)$/.test(normalized)) return "blue";
      if (/^(?:green|أخضر|خضراء)$/.test(normalized)) return "green";
      if (/^(?:black|أسود|سوداء)$/.test(normalized)) return "black";
      return normalized;
    };
    if (
      typeof aValue === "string"
      && typeof bValue === "string"
      && canonicalAttribute(aValue) !== canonicalAttribute(bValue)
    ) {
      return false;
    }
  }
  return true;
}

function canonicalBotanical(requirement: RecipeRequirement): string | null {
    if (requirement.subtype !== "botanical") return requirement.subtype ?? null;
    const phrase = normalize(requirement.phrase);
    if (/\b(?:roses?|spray rose|baby rose)\b|ورد|ورود/.test(phrase)) return "rose";
    if (/\btulips?\b|توليب/.test(phrase)) return "tulip";
    if (/\birises?\b|سوسن/.test(phrase)) return "iris";
    if (/\borchids?\b|أوركيد/.test(phrase)) return "orchid";
    return null;
}

function samePhysicalComponent(a: RecipeRequirement, b: RecipeRequirement): boolean {
  if (a.subtype !== b.subtype || a.quantity !== b.quantity) return false;
  const aTokens = new Set(matchingTokens(a.phrase));
  const bTokens = new Set(matchingTokens(b.phrase));
  if (aTokens.size === 0 || bTokens.size === 0) return false;
  // A generic reference such as “balloon” and a qualified reference such as
  // “foil balloon” are the same physical component.  Distinct qualifiers such
  // as “red” and “pink” must remain separate.
  if (
    (
      [...aTokens].every((token) => bTokens.has(token))
      || [...bTokens].every((token) => aTokens.has(token))
    )
    && compatibleRequirementAttributes(a, b)
  ) return true;
  if (a.subtype === "balloon") {
    const isBalloon = (requirement: RecipeRequirement) =>
      matchingTokens(requirement.phrase).includes("balloon");
    if (isBalloon(a) && isBalloon(b) && compatibleRequirementAttributes(a, b)) return true;
  }
  if (a.subtype === "container") {
    const containerFamily = (requirement: RecipeRequirement) =>
      normalize(requirement.phrase).match(/\b(box|boxes|vase|vases|basket|baskets)\b/)?.[1]?.replace(/es$/, "").replace(/s$/, "") ?? null;
    if (
      containerFamily(a) !== null
      && containerFamily(a) === containerFamily(b)
      && compatibleRequirementAttributes(a, b)
    ) return true;
  }
  const bilingual = a.evidence.sourceField === "descriptionAr" || b.evidence.sourceField === "descriptionAr";
  if (!bilingual) return false;
  const aFamily = canonicalBotanical(a);
  if (aFamily === null || aFamily !== canonicalBotanical(b)) return false;
  return compatibleRequirementAttributes(a, b);
}

function deduplicatePhysicalComponents(extracted: ExtractedRequirement[]): RecipeRequirement[] {
  const explicitDescriptionComponents = extracted.filter(({ requirement, compositionScore }) =>
    (requirement.evidence.sourceField === "description" || requirement.evidence.sourceField === "descriptionAr")
    && compositionScore > 0,
  );
  const compositionScoped = extracted.filter((candidate) => {
    if (
      candidate.requirement.evidence.sourceField !== "name"
      || candidate.explicitQuantity
      || !["botanical", "container", "balloon"].includes(candidate.requirement.subtype ?? "")
    ) return true;
    const sameSubtype = explicitDescriptionComponents.filter(({ requirement }) =>
      requirement.subtype === candidate.requirement.subtype,
    );
    return sameSubtype.length === 0
      || sameSubtype.some(({ requirement }) => samePhysicalComponent(candidate.requirement, requirement));
  });
  const kept: ExtractedRequirement[] = [];
  for (const candidate of compositionScoped) {
    const duplicateIndex = kept.findIndex((existing) =>
      (
        existing.requirement.evidence.sourceField !== candidate.requirement.evidence.sourceField
        || (
          existing.requirement.evidence.lineIndex === candidate.requirement.evidence.lineIndex
          && !(existing.explicitQuantity && candidate.explicitQuantity)
        )
      )
      && samePhysicalComponent(existing.requirement, candidate.requirement),
    );
    if (duplicateIndex < 0) {
      kept.push(candidate);
      continue;
    }
    const existing = kept[duplicateIndex];
    const candidateScore = candidate.compositionScore + (candidate.explicitQuantity ? 1 : 0);
    const existingScore = existing.compositionScore + (existing.explicitQuantity ? 1 : 0);
    if (candidateScore > existingScore) {
      candidate.requirement.attributes = {
        ...existing.requirement.attributes,
        ...candidate.requirement.attributes,
      };
      candidate.requirement.additionalEvidence = [
        existing.requirement.evidence,
        ...(existing.requirement.additionalEvidence ?? []),
        ...(candidate.requirement.additionalEvidence ?? []),
      ];
      kept[duplicateIndex] = candidate;
    } else {
      existing.requirement.attributes = {
        ...candidate.requirement.attributes,
        ...existing.requirement.attributes,
      };
      existing.requirement.additionalEvidence = [
        ...(existing.requirement.additionalEvidence ?? []),
        candidate.requirement.evidence,
        ...(candidate.requirement.additionalEvidence ?? []),
      ];
    }
  }
  return kept.map(({ requirement }) => requirement);
}

export function extractRecipeRequirements(
  product: Pick<SuggestionProduct, "name" | "description" | "descriptionAr" | "category" | "tags">,
): RecipeRequirement[] {
  const sources: Array<{ sourceField: RecipeRequirementEvidence["sourceField"]; sourceIndex: number; text: string }> = [
    { sourceField: "name", sourceIndex: 0, text: product.name },
    { sourceField: "description", sourceIndex: 0, text: product.description ?? "" },
    { sourceField: "descriptionAr", sourceIndex: 0, text: product.descriptionAr ?? "" },
    ...(product.tags ?? []).map((text, sourceIndex) => ({ sourceField: "tag" as const, sourceIndex, text })),
  ];
  const extracted: ExtractedRequirement[] = [];
  const occurrences = new Map<string, number>();
  for (const source of sources) {
    const lines = source.text.split(/\r?\n/);
    lines.forEach((line, lineIndex) => {
      const matches: Array<{ match: RegExpExecArray; policy: typeof SUPPORTED_COMPONENTS[number] }> = [];
      for (const policy of SUPPORTED_COMPONENTS) {
        policy.pattern.lastIndex = 0;
        for (const match of line.matchAll(policy.pattern)) matches.push({ match, policy });
      }
      matches.sort((a, b) => (a.match.index ?? 0) - (b.match.index ?? 0));
      const semanticMatches = matches.filter(({ match, policy }, index) => {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        return !matches.some(({ match: other, policy: otherPolicy }, otherIndex) => {
          if (index === otherIndex || other[0].length <= match[0].length) return false;
          if (
            (policy.subtype === "helium_fill" && otherPolicy.subtype === "balloon")
            || (policy.subtype === "balloon" && otherPolicy.subtype === "helium_fill")
          ) return false;
          const otherStart = other.index ?? 0;
          const otherEnd = otherStart + other[0].length;
          return otherStart <= start && otherEnd >= end;
        });
      });
      semanticMatches.forEach(({ match, policy }, componentIndex) => {
        const exactPhrase = match[3] ?? match[2] ?? match[0];
        const requirementPhrase = policy.subtype === "helium_fill"
          ? "Helium"
          : policy.subtype === "balloon"
            ? exactPhrase.replace(/\bhelium[-\s]+filled\s*/i, "").trim()
            : exactPhrase;
        const normalizedPhrase = normalize(requirementPhrase);
        if (!normalizedPhrase) return;
        if (
          (source.sourceField === "description" || source.sourceField === "descriptionAr")
          && normalize(line).match(new RegExp(`^${escapeRegExp(normalizedPhrase)}\\s+(?:includes?|contains?)$`))
        ) return;
        const exactPhraseStart = (match.index ?? 0) + match[0].indexOf(exactPhrase);
        const nextComponentStart = semanticMatches
          .slice(componentIndex + 1)
          .find(({ match: nextMatch }) => (nextMatch.index ?? line.length) > exactPhraseStart)
          ?.match.index ?? line.length;
        const semanticClause = line.slice(exactPhraseStart, nextComponentStart).trim();
        const suffix = line.slice((match.index ?? 0) + match[0].length);
        const prefix = line.slice(0, match.index ?? 0);
        if (policy.subtype === "botanical" && /^[-\s]*(?:box|basket)\b/i.test(suffix)) return;
        if (
          policy.subtype === "botanical"
          && (suffix.startsWith("-") || (prefix.endsWith("-") && !/\b\d+\s*[- ]pack-$/i.test(prefix)))
        ) return;
        if (policy.subtype === "botanical" && /صندوق\s*$/u.test(prefix)) return;
        if (policy.subtype === "product" && /^[-\s]*cakes?\b/i.test(suffix)) return;
        if (policy.subtype === "ribbon" && /\b\w+-\w+\s*$/i.test(prefix)) return;
        const quantityRaw = policy.subtype === "catalog_reference" ? undefined : match[1];
        const heliumBalloonMatch = policy.subtype === "helium_fill"
          ? semanticMatches
            .filter(({ policy: candidatePolicy }) => candidatePolicy.subtype === "balloon")
            .map(({ match: candidateMatch }) => candidateMatch)
            .sort((a, b) =>
              Math.abs((a.index ?? 0) - (match.index ?? 0))
              - Math.abs((b.index ?? 0) - (match.index ?? 0)),
            )[0]
          : undefined;
        const packageOfCount = prefix.match(/\bpack(?:age)?\s+of\s*$/i) && quantityRaw
          ? Number(quantityRaw)
          : Number(prefix.match(/\b(\d+)\s*[- ]pack\s*$/i)?.[1]);
        const truePackageSize = Number.isFinite(packageOfCount) && packageOfCount > 0
          ? packageOfCount
          : null;
        const resolvedQuantityRaw = policy.subtype === "helium_fill"
          ? quantityRaw ?? heliumBalloonMatch?.[1]
          : truePackageSize == null ? quantityRaw : undefined;
        const quantityRange = prefix.match(/(\d+(?:\.\d+)?)\s*(?:to|[-–])\s*$/i);
        const compositionScore = source.sourceField === "name"
          ? 2
          : source.sourceField === "tag"
            ? 1
            : hasDescriptionCompositionContext(line, exactPhrase, exactPhraseStart, quantityRaw);
        if (source.sourceField === "description" || source.sourceField === "descriptionAr") {
          if (compositionScore === 0) return;
        }
        if (
          source.sourceField === "tag"
          && new Set(["flower", "flowers", "greenery", "gift", "gifts", "balloon", "balloons", "cake", "cakes"])
            .has(normalizedPhrase)
        ) return;
        if (
          policy.subtype === "gift"
          && /^gifts?$/i.test(exactPhrase.trim())
          && !/\b(?:includes?|contains?|bundle)\b|[,+&]/i.test(line)
        ) return;
        const occurrenceKey = `${source.sourceField}|${source.sourceIndex}|${normalizedPhrase}`;
        const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
        occurrences.set(occurrenceKey, occurrence);
        const evidenceValue: RecipeRequirementEvidence = {
          sourceField: source.sourceField,
          sourceIndex: source.sourceIndex,
          lineIndex,
          componentIndex,
          occurrence,
          exactPhrase,
          normalizedPhrase,
          span: { start: exactPhraseStart, end: exactPhraseStart + exactPhrase.length },
          semanticSpan: { start: exactPhraseStart, end: nextComponentStart },
        };
        const unitRaw = match[2] && match[3] ? match[2] : null;
        const attributes = requirementAttributes(
          requirementPhrase,
          policy.subtype === "helium_fill" ? line : semanticClause,
        );
        if (policy.subtype === "balloon") {
          const balloonType = semanticClause.match(/\b(foil|latex|physical)\s+balloons?\b/i)?.[1]
            ?? requirementPhrase.match(/\b(foil|latex|physical)\s+balloons?\b/i)?.[1];
          if (balloonType) attributes.balloonType = balloonType.toLowerCase();
        }
        if (truePackageSize != null) attributes.packageSize = truePackageSize;
        if (policy.subtype === "helium_fill") {
          attributes.fill = "helium";
          const balloonType = line.match(/\b(foil|latex|physical)\s+balloons?\b/i)?.[1];
          if (balloonType) attributes.balloonType = balloonType.toLowerCase();
        }
        if (quantityRange && resolvedQuantityRaw) {
          attributes.quantityMin = Number(quantityRange[1]);
          attributes.quantityMax = parseRequirementQuantity(resolvedQuantityRaw);
        }
        extracted.push({
          requirement: {
            requirementId: stableRequirementId(evidenceValue),
            kind: policy.kind,
            subtype: policy.subtype,
            category: policy.category,
            phrase: requirementPhrase,
            quantity: parseRequirementQuantity(resolvedQuantityRaw),
            unit: unitRaw ?? null,
            attributes,
            candidateBaseItemIds: [],
            resolution: "no_match",
            evidence: evidenceValue,
            similarEvidence: [],
          },
          compositionScore,
          explicitQuantity: Boolean(resolvedQuantityRaw),
        });
      });
    });
  }
  const requirements = deduplicatePhysicalComponents(extracted);
  for (const helium of requirements.filter(({ subtype }) => subtype === "helium_fill")) {
    const heliumEvidence = [helium.evidence, ...(helium.additionalEvidence ?? [])];
    for (const balloon of requirements.filter(({ subtype }) => subtype === "balloon")) {
      const balloonEvidence = [balloon.evidence, ...(balloon.additionalEvidence ?? [])];
      if (heliumEvidence.some((heliumSource) =>
        balloonEvidence.some((balloonSource) =>
          heliumSource.sourceField === balloonSource.sourceField
          && heliumSource.sourceIndex === balloonSource.sourceIndex
          && heliumSource.lineIndex === balloonSource.lineIndex
        )
      )) {
        balloon.attributes.fill = "helium";
      }
    }
  }
  const explicitKeys = new Set(
    requirements
      .filter((requirement) =>
        requirement.evidence.sourceField === "name"
        || requirement.evidence.sourceField === "description"
        || requirement.evidence.sourceField === "descriptionAr"
      )
      .map((requirement) => `${requirement.subtype}|${matchingTokens(requirement.phrase).join(" ")}`),
  );
  return requirements.filter((requirement) =>
    requirement.evidence.sourceField !== "tag"
    || !explicitKeys.has(`${requirement.subtype}|${matchingTokens(requirement.phrase).join(" ")}`),
  );
}

function generateRecipeSuggestionInternal(
  target: RecipeSuggestionTarget,
  supportingProducts: SuggestionProduct[],
  baseItems: RecipeLineInput[],
  activeRules: OperationalRuleActivation = DEFAULT_OPERATIONAL_RULES,
  activeCandidateIds?: readonly number[],
  contextualResolutionEnabled = true,
  approvedContextualRules: readonly ApprovedContextualRule[] = [],
): RecipeSuggestion {
  const structure = extractProductStructure(target);
  const requirements = extractRecipeRequirements(target);
  const contextualRuleDiagnostics: ContextualRuleDiagnostic[] = [];
  const lines = new Map<string, SuggestionLine>();
  const unresolvedLines: string[] = [];
  const unresolvedRequirements: RecipeSuggestion["unresolvedRequirements"] = [];
  for (const requirement of requirements) {
    const retrieved = baseItems.filter((item) => {
      if (!lexicallyRelated(requirement, item)) return false;
      if (
        requirement.subtype === "botanical"
        && matchingTokens(item.baseItemName).some((token) => ["ribbon", "sponge", "ring"].includes(token))
      ) return false;
      if (requirement.subtype === "catalog_reference") return true;
      const candidateComponents = extractRecipeRequirements({ name: item.baseItemName });
      return !candidateComponents.some((component) =>
        component.subtype !== requirement.subtype && component.category !== requirement.category,
      );
    });
    requirement.preCompatibilityCandidateBaseItemIds = retrieved.map((item) => item.baseItemId);
    const diagnostics = retrieved.map((item) => compareCandidate(requirement, item));
    requirement.candidateCompatibility = diagnostics;
    const candidates = retrieved.filter((item) =>
      diagnostics.find((diagnostic) => diagnostic.baseItemId === item.baseItemId)?.survivor,
    );
    requirement.candidateBaseItemIds = [...new Set(candidates.map((item) => item.baseItemId))].sort((a, b) => a - b);
    const soleDiagnostic = candidates.length === 1
      ? diagnostics.find(({ baseItemId }) => baseItemId === candidates[0].baseItemId)
      : undefined;
    requirement.resolution = candidates.length === 0
      ? "no_match"
      : candidates.length === 1 && !soleDiagnostic?.hasUnknownExplicitDiscriminator
        ? "matched"
        : "ambiguous";
    const contextualVariant = contextualResolutionEnabled && candidates.length > 1
      ? contextualRoseVariant(
          target,
          requirement,
          candidates.map((item) => ({
            item,
            diagnostic: diagnostics.find(({ baseItemId }) => baseItemId === item.baseItemId)!,
          })),
          approvedContextualRules,
        )
      : null;
    if (contextualResolutionEnabled && requirement.subtype === "botanical" && approvedContextualRules.length > 0) {
      for (const rule of approvedContextualRules) {
        const verified = candidates.find((item) => item.baseItemId === rule.resolverBaseItemId);
        const verifiedValue = verified ? governedTrustedStemLength(verified) : null;
        const formatEligible = structure.formatResolution.contextualRuleFormatEligible
          && structure.formatResolution.authoritativePrimaryFormat != null
          && rule.canonicalFormats.includes(structure.formatResolution.authoritativePrimaryFormat);
        const explicitStem = requirementDiscriminators(requirement).stemLength;
        const requiredFamily = botanicalIdentity(requirement.phrase).family;
        const requiredColor = canonicalValue(requirement.attributes.color);
        const familyEligible = !rule.ingredientFamily
          || requiredFamily === singularize(rule.ingredientFamily.toLowerCase());
        const colorEligible = !rule.color || requiredColor === canonicalValue(rule.color);
        const valueEligible = rule.stemLengthCm != null
          && verifiedValue != null
          && Math.abs(verifiedValue - rule.stemLengthCm) <= DIMENSION_TOLERANCE_CM;
        const applied = contextualVariant?.rule === rule;
        contextualRuleDiagnostics.push({
          ruleId: rule.ruleId ?? null,
          ruleKey: rule.ruleKey ?? null,
          resolverBaseItemId: rule.resolverBaseItemId,
          canonicalFormats: [...rule.canonicalFormats],
          authoritativePrimaryFormat: structure.formatResolution.authoritativePrimaryFormat,
          outcome: applied ? "applied" : "rejected",
          reason: applied ? "Approved contextual rule resolved exactly one missing governed stem-length attribute."
            : explicitStem != null ? "An explicit governed stem length cannot be overridden."
              : !formatEligible ? "The Product format is not authoritatively resolved and eligible for this rule."
                : !familyEligible ? "The semantic requirement ingredient family does not satisfy this rule."
                  : !colorEligible ? "The semantic requirement color does not satisfy this rule."
                    : rule.stemLengthCm == null ? "The rule does not declare the governed stem-length value."
                : !verified ? "The configured resolver Base Item is not a compatible candidate."
                  : verifiedValue == null ? "The resolver Base Item does not independently establish one governed stem length."
                    : !valueEligible ? "The resolver Base Item's independently verified stem length disagrees with the rule."
                      : "Another applicable rule or candidate prevented a unique contextual resolution.",
          requirementId: requirement.requirementId,
          preserved: {
            quantity: requirement.quantity,
            unit: requirement.unit,
            evidence: requirement.evidence,
            additionalEvidence: [...(requirement.additionalEvidence ?? [])],
            provenance: [requirement.evidence, ...(requirement.additionalEvidence ?? [])],
          },
          independentlyVerifiedGovernedValue: verifiedValue,
        });
      }
    }
    if (contextualVariant) {
      const rule = contextualVariant.rule;
      addLine(lines, {
        ...contextualVariant.item,
        quantity: requirement.quantity,
        source: "deterministic_rule",
        confidence: "high",
        reason: `Confirmed red-rose ${contextualVariant.stemLengthCm}cm variant for ${extractProductStructure(target).productFormat.value ?? "the governed format"}.`,
        hiddenRuleKey: null,
        unresolved: false,
        requirementId: requirement.requirementId,
        requirementEvidence: requirement.evidence,
        requirementProvenance: requirement,
        contextualRuleProvenance: {
          resolverBaseItemId: contextualVariant.item.baseItemId,
          canonicalFormat: structure.productFormat.value ?? "Unknown",
          stemLengthCm: rule?.stemLengthCm ?? null,
        },
      });
      requirement.resolution = "matched";
      continue;
    }
    if (candidates.length !== 1 || soleDiagnostic?.hasUnknownExplicitDiscriminator) {
      addUnresolved(unresolvedLines, unresolvedRequirements, {
        requirementId: requirement.requirementId,
        requirement: `${requirement.quantity > 1 ? `${requirement.quantity} ` : ""}${requirement.phrase}${candidates.length > 1 ? " (ambiguous Base Item variant; review required)" : ""}`,
        quantity: requirement.quantity,
        reason: candidates.length > 1
          ? `The explicit requirement has multiple credible Base Item candidates: ${candidates.map((item) => item.baseItemName).join(", ")}.`
          : candidates.length === 1
            ? `The sole non-incompatible Base Item candidate has unknown trusted evidence for an explicit discriminator: ${candidates[0].baseItemName}.`
          : "The explicit supported Recipe component has no credible existing Base Item match.",
        candidateBaseItemIds: requirement.candidateBaseItemIds.length ? requirement.candidateBaseItemIds : undefined,
        requirementProvenance: requirement,
      });
      continue;
    }
    const selected = candidates[0];
    addLine(lines, {
      ...selected,
      quantity: requirement.quantity,
      source: "deterministic_rule",
      confidence: "high",
      reason: `Explicit ${requirement.kind}/${requirement.subtype ?? "other"} requirement "${requirement.phrase}" matched an existing Base Item.`,
      hiddenRuleKey: null,
      unresolved: false,
      requirementId: requirement.requirementId,
      requirementEvidence: requirement.evidence,
      requirementProvenance: requirement,
    });
  }

  const rankedSimilar = supportingProducts
    .filter((product) => product.id !== target.id)
    .map((product) => ({ product, score: similarity(target, product) }))
    .filter(({ score }) => score >= 0.2)
    .sort((a, b) => b.score - a.score || a.product.id - b.product.id)
    .slice(0, 5);

  const supportingProductIds = rankedSimilar.map(({ product }) => product.id);
  const supportByBaseItem = new Map<number, { quantities: number[]; productIds: number[]; name: string; code?: string | null }>();
  const suppliedCandidateIds = activeCandidateIds
    ?? target.activeCandidateIds
    ?? (Array.isArray(target.metadata?.activeCandidateIds)
      ? target.metadata.activeCandidateIds.filter((id): id is number => typeof id === "number")
      : undefined);
  const activeCandidateIdSet = suppliedCandidateIds ? new Set(suppliedCandidateIds) : null;
  for (const { product } of rankedSimilar) {
    for (const recipeLine of product.recipes) {
      // Similar recipes are evidence only for the caller's active shortlist;
      // direct text matching above remains independent catalog matching.
      if (activeCandidateIdSet && !activeCandidateIdSet.has(recipeLine.baseItemId)) continue;
      const entry = supportByBaseItem.get(recipeLine.baseItemId) ?? {
        quantities: [],
        productIds: [],
        name: recipeLine.baseItemName,
        code: recipeLine.baseItemCode,
      };
      entry.quantities.push(recipeLine.quantity);
      entry.productIds.push(product.id);
      supportByBaseItem.set(recipeLine.baseItemId, entry);
    }
  }

  const conflicts: RecipeSuggestion["conflicts"] = [];
  for (const [baseItemId, evidence] of supportByBaseItem) {
    const uniqueQuantities = [...new Set(evidence.quantities)].sort((a, b) => a - b);
    if (uniqueQuantities.length > 1) {
      conflicts.push({
        baseItemId,
        baseItemName: evidence.name,
        quantities: uniqueQuantities,
        supportingProductIds: evidence.productIds,
      });
      continue;
    }
    for (const requirement of requirements.filter((item) => item.candidateBaseItemIds.includes(baseItemId))) {
      requirement.similarEvidence.push({ baseItemId, supportingProductIds: evidence.productIds });
    }
  }

  applyOperationalRules(target, baseItems, requirements, lines, unresolvedLines, unresolvedRequirements, activeRules);

  if (lines.size === 0 && unresolvedLines.length === 0) {
    addUnresolved(unresolvedLines, unresolvedRequirements, {
      requirementId: "product:no-supported-requirement",
      requirement: "No supported explicit Recipe component was found in product text.",
      quantity: 1,
      reason: "No safe existing Base Item match was found.",
    });
  }

  const evidenceSummary: Record<RecipeEvidenceSource, number> = {
    deterministic_rule: 0,
    similar_product: 0,
    ai_assisted: 0,
    unresolved: unresolvedLines.length,
    conflict: conflicts.length,
  };
  for (const line of lines.values()) evidenceSummary[line.source] += 1;

  return {
    targetProductId: target.id,
    engineVersion: RECIPE_SUGGESTION_ENGINE_VERSION,
    structure,
    requirements,
    lines: [...lines.values()].sort((a, b) => a.baseItemId - b.baseItemId),
    similarProducts: rankedSimilar.map(({ product, score }) => ({
      productId: product.id,
      name: product.name,
      score: Number(score.toFixed(4)),
    })),
    conflicts,
    unresolvedLines,
    unresolvedRequirements,
    evidenceSummary,
    leaveOneOut: {
      directRecipeWithheld: true,
      excludedProductId: target.id,
      supportingProductIds,
    },
    ruleSetVersion: RECIPE_SUGGESTION_RULESET_VERSION,
    contextualRuleDiagnostics,
  };
}

export function generateRecipeSuggestion(
  target: RecipeSuggestionTarget,
  supportingProducts: SuggestionProduct[],
  baseItems: RecipeLineInput[],
  activeRules: OperationalRuleActivation = DEFAULT_OPERATIONAL_RULES,
  activeCandidateIds?: readonly number[],
  approvedContextualRules: readonly ApprovedContextualRule[] = [],
): RecipeSuggestion {
  return generateRecipeSuggestionInternal(
    target,
    supportingProducts,
    baseItems,
    activeRules,
    activeCandidateIds,
    true,
    approvedContextualRules,
  );
}


export type RecipeComparison = {
  baseItem: {
    expectedCount: number;
    suggestedCount: number;
    matchedCount: number;
    precision: number;
    recall: number;
    f1: number;
  };
  quantity: {
    comparedCount: number;
    correctCount: number;
    accuracy: number;
    tolerance: number;
  };
  missingItems: RecipeLineInput[];
  incorrectExtras: SuggestionLine[];
  hiddenRule: {
    expectedCount: number;
    matchedCount: number;
    accuracy: number | null;
    expectedOperationalItems: RecipeLineInput[];
    matchedOperationalItems: number[];
  };
  confidenceDistribution: Record<SuggestionConfidence, number>;
  productType: string;
  unresolvedLines: string[];
  conflicts: RecipeSuggestion["conflicts"];
};

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function isOperationalItem(name: string): boolean {
  return /(sponge|box|basket|vase|ribbon|wrap|pack|ring|container|card|bag)/i.test(name);
}

export function compareRecipeSuggestion(
  suggestion: RecipeSuggestion,
  approvedRecipe: RecipeLineInput[],
  target: SuggestionProduct,
): RecipeComparison {
  const expected = new Map(approvedRecipe.map((line) => [line.baseItemId, line]));
  const suggested = new Map(suggestion.lines.map((line) => [line.baseItemId, line]));
  const matchedIds = [...expected.keys()].filter((id) => suggested.has(id));
  const missingItems = [...expected.entries()]
    .filter(([id]) => !suggested.has(id))
    .map(([, line]) => line);
  const incorrectExtras = [...suggested.entries()]
    .filter(([id]) => !expected.has(id))
    .map(([, line]) => line);
  const precision = suggested.size === 0 ? 0 : matchedIds.length / suggested.size;
  const recall = expected.size === 0 ? 1 : matchedIds.length / expected.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const quantityCompared = matchedIds.length;
  const quantityCorrect = matchedIds.filter(
    (id) => Math.abs(expected.get(id)!.quantity - suggested.get(id)!.quantity) < 0.000001,
  ).length;

  const expectedOperationalItems = approvedRecipe.filter((line) => isOperationalItem(line.baseItemName));
  const matchedOperationalItems = expectedOperationalItems
    .filter((line) => {
      const generated = suggested.get(line.baseItemId);
      return generated && Math.abs(generated.quantity - line.quantity) < 0.000001;
    })
    .map((line) => line.baseItemId);
  const confidenceDistribution: Record<SuggestionConfidence, number> = {
    high: 0,
    medium: 0,
    low: 0,
    no_match: 0,
  };
  for (const line of suggestion.lines) confidenceDistribution[line.confidence] += 1;

  return {
    baseItem: {
      expectedCount: expected.size,
      suggestedCount: suggested.size,
      matchedCount: matchedIds.length,
      precision: roundMetric(precision),
      recall: roundMetric(recall),
      f1: roundMetric(f1),
    },
    quantity: {
      comparedCount: quantityCompared,
      correctCount: quantityCorrect,
      accuracy: quantityCompared === 0 ? 0 : roundMetric(quantityCorrect / quantityCompared),
      tolerance: 0,
    },
    missingItems,
    incorrectExtras,
    hiddenRule: {
      expectedCount: expectedOperationalItems.length,
      matchedCount: matchedOperationalItems.length,
      accuracy: expectedOperationalItems.length === 0
        ? null
        : roundMetric(matchedOperationalItems.length / expectedOperationalItems.length),
      expectedOperationalItems,
      matchedOperationalItems,
    },
    confidenceDistribution,
    productType: productType(target),
    unresolvedLines: suggestion.unresolvedLines,
    conflicts: suggestion.conflicts,
  };
}
