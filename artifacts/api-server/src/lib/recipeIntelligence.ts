import { db } from "./db";

export type RecipeAudit = {
  generated_at: string;
  input_audit: {
    fields_used: string[];
    translation_performed: false;
    language_availability: {
      english_name_products: number;
      english_description_products: number;
      arabic_description_products: number;
      products_with_any_arabic_text: number;
    };
    image_analysis: {
      available_product_images: number;
      policy: "format_support_only";
      enabled: false;
    };
  };
  coverage: {
    total_products: number;
    products_with_recipe: number;
    products_without_recipe: number;
    complete_recipe_count: number;
    completeness_percent: number;
  };
  common_base_items: Array<{
    base_item_id: number;
    name: string;
    code: string;
    usage_count: number;
    product_count: number;
  }>;
  packaging_patterns: Array<{
    base_item_id: number;
    name: string;
    product_count: number;
    products: Array<{ id: number; name: string }>;
  }>;
  candidate_rules: RecipeRuleCandidate[];
  conflicting_patterns: Array<{
    rule_key: string;
    product_id: number;
    product_name: string;
    reason: string;
  }>;
  recipes_needing_review: Array<{
    product_id: number;
    product_name: string;
    reasons: string[];
  }>;
};

export type RecipeRuleCandidate = {
  rule_key: string;
  name: string;
  description: string;
  rule_type: "hidden_item";
  source: "deterministic" | "discovered";
  confidence: number;
  definition: Record<string, unknown>;
  supporting_evidence: Array<RecipeRuleEvidenceInput>;
  conflicting_evidence: Array<RecipeRuleEvidenceInput>;
};

export type RecipeRuleEvidenceInput = {
  evidence_type: "supporting" | "conflicting" | "observation";
  product_id: number | null;
  base_item_id: number | null;
  product_name_snapshot: string | null;
  base_item_name_snapshot: string | null;
  details: Record<string, unknown>;
};

type ProductRecipeSummary = {
  product_id: number;
  product_name: string;
  description: string | null;
  description_ar: string | null;
  tags: string[] | null;
  main_image_url: string | null;
  recipe_count: number;
  catalog_categories: string[] | null;
};

type RecipeLine = {
  product_id: number;
  product_name: string;
  base_item_id: number;
  base_item_name: string;
  base_item_code: string;
  base_item_type: string | null;
  base_item_status: string | null;
  base_item_category_name: string | null;
  base_item_category_type: string | null;
};

const PACKAGING_TERM = /\b(box|sponge|ring|wrap|ribbon|vase|basket|bag|foam|packag)/i;

export const DETERMINISTIC_RECIPE_RULES = [
  {
    rule_key: "flower-box-sponge",
    name: "Flower-box products need sponge",
    description: "Suggest a sponge when a flower-box product has a flower-box component.",
    definition: {
      product_keywords: ["flower", "box"],
      required_base_item_keywords: ["sponge"],
    },
  },
  {
    rule_key: "balloon-metal-ring",
    name: "Balloon products need a metal ring",
    description: "Suggest a metal ring when a balloon product needs structural support.",
    definition: {
      product_keywords: ["balloon"],
      required_base_item_keywords: ["metal ring", "ring"],
    },
  },
] as const;

function safeArray(value: string[] | null): string[] {
  return Array.isArray(value) ? value : [];
}

function productText(product: ProductRecipeSummary): string {
  return [
    product.product_name,
    product.description ?? "",
    ...safeArray(product.tags),
    ...safeArray(product.catalog_categories),
  ]
    .join(" ")
    .toLowerCase();
}

function isPackaging(line: RecipeLine): boolean {
  return PACKAGING_TERM.test(
    [
      line.base_item_name,
      line.base_item_type ?? "",
      line.base_item_category_name ?? "",
      line.base_item_category_type ?? "",
    ].join(" "),
  );
}

function matchesRuleProduct(
  product: ProductRecipeSummary,
  keywords: readonly string[],
): boolean {
  const text = productText(product);
  return keywords.every((keyword) => text.includes(keyword));
}

function matchesRequiredItem(line: RecipeLine, keywords: readonly string[]): boolean {
  const itemText = [
    line.base_item_name,
    line.base_item_code,
    line.base_item_type ?? "",
    line.base_item_category_name ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return keywords.some((keyword) => itemText.includes(keyword));
}

/**
 * Read current live recipes as evidence, but never mutates them. The resulting
 * report is intentionally deterministic: no AI call or model output is needed
 * before a manager has decided which rules are safe to activate.
 */
export async function analyzeRecipeWorkspace(workspaceOwnerId: string): Promise<RecipeAudit> {
  const [productsResult, linesResult] = await Promise.all([
    db.query<ProductRecipeSummary>(
      `SELECT p.id AS product_id,
              p.name AS product_name,
              p.description,
              p.description_ar,
              p.tags,
              p.main_image_url,
              COUNT(DISTINCT pr.id)::int AS recipe_count,
              COALESCE(
                array_agg(DISTINCT cc.name) FILTER (WHERE cc.name IS NOT NULL),
                ARRAY[]::text[]
              ) AS catalog_categories
         FROM products p
         LEFT JOIN product_recipes pr
           ON pr.product_id = p.id
          AND pr.workspace_owner_id = p.workspace_owner_id
         LEFT JOIN product_catalog_categories pcc ON pcc.product_id = p.id
         LEFT JOIN catalog_categories cc
           ON cc.id = pcc.attribute_id
          AND cc.workspace_owner_id = p.workspace_owner_id
        WHERE p.workspace_owner_id = $1
          AND COALESCE(p.is_archived, false) = false
        GROUP BY p.id, p.name, p.description, p.description_ar, p.tags, p.main_image_url
        ORDER BY p.name ASC`,
      [workspaceOwnerId],
    ),
    db.query<RecipeLine>(
      `SELECT pr.product_id,
              p.name AS product_name,
              bi.id AS base_item_id,
              bi.name AS base_item_name,
              bi.code AS base_item_code,
              bi.type AS base_item_type,
              bi.status AS base_item_status,
              bic.name AS base_item_category_name,
              bic.category_type AS base_item_category_type
         FROM product_recipes pr
         JOIN products p
           ON p.id = pr.product_id
          AND p.workspace_owner_id = pr.workspace_owner_id
         JOIN base_items bi
           ON bi.id = pr.base_item_id
          AND bi.workspace_owner_id = pr.workspace_owner_id
         LEFT JOIN base_item_categories bic
           ON bic.id = bi.category_id
          AND bic.workspace_owner_id = bi.workspace_owner_id
        WHERE pr.workspace_owner_id = $1
        ORDER BY pr.product_id, pr.sort_order, pr.id`,
      [workspaceOwnerId],
    ),
  ]);

  const products = productsResult.rows;
  const lines = linesResult.rows;
  const linesByProduct = new Map<number, RecipeLine[]>();
  const baseItemUsage = new Map<number, { line: RecipeLine; usage: number; productIds: Set<number> }>();

  for (const line of lines) {
    const productLines = linesByProduct.get(line.product_id) ?? [];
    productLines.push(line);
    linesByProduct.set(line.product_id, productLines);

    const item = baseItemUsage.get(line.base_item_id) ?? {
      line,
      usage: 0,
      productIds: new Set<number>(),
    };
    item.usage += 1;
    item.productIds.add(line.product_id);
    baseItemUsage.set(line.base_item_id, item);
  }

  const productsWithRecipe = products.filter((product) => product.recipe_count > 0);
  const commonBaseItems = [...baseItemUsage.values()]
    .sort((a, b) => b.usage - a.usage || a.line.base_item_name.localeCompare(b.line.base_item_name))
    .slice(0, 20)
    .map(({ line, usage, productIds }) => ({
      base_item_id: line.base_item_id,
      name: line.base_item_name,
      code: line.base_item_code,
      usage_count: usage,
      product_count: productIds.size,
    }));

  const productNames = new Map(products.map((product) => [product.product_id, product.product_name]));
  const packagingPatterns = [...baseItemUsage.values()]
    .filter(({ line, productIds }) => isPackaging(line) && productIds.size >= 1)
    .sort((a, b) => b.productIds.size - a.productIds.size || a.line.base_item_name.localeCompare(b.line.base_item_name))
    .slice(0, 20)
    .map(({ line, productIds }) => ({
      base_item_id: line.base_item_id,
      name: line.base_item_name,
      product_count: productIds.size,
      products: [...productIds].slice(0, 10).map((id) => ({ id, name: productNames.get(id) ?? "Unknown product" })),
    }));

  const candidateRules: RecipeRuleCandidate[] = [];
  const conflicts: RecipeAudit["conflicting_patterns"] = [];

  for (const seed of DETERMINISTIC_RECIPE_RULES) {
    const productKeywords = seed.definition.product_keywords;
    const requiredKeywords = seed.definition.required_base_item_keywords;
    const matchingProducts = products.filter((product) => matchesRuleProduct(product, productKeywords));
    const supportingEvidence: RecipeRuleEvidenceInput[] = [];
    const conflictingEvidence: RecipeRuleEvidenceInput[] = [];

    for (const product of matchingProducts) {
      const matchingLine = (linesByProduct.get(product.product_id) ?? []).find((line) =>
        matchesRequiredItem(line, requiredKeywords),
      );
      if (matchingLine) {
        supportingEvidence.push({
          evidence_type: "supporting",
          product_id: product.product_id,
          base_item_id: matchingLine.base_item_id,
          product_name_snapshot: product.product_name,
          base_item_name_snapshot: matchingLine.base_item_name,
          details: { observed_in_live_recipe: true },
        });
      } else {
        const reason = `Matches ${seed.name} pattern but has no required hidden item`;
        const evidence: RecipeRuleEvidenceInput = {
          evidence_type: "conflicting",
          product_id: product.product_id,
          base_item_id: null,
          product_name_snapshot: product.product_name,
          base_item_name_snapshot: null,
          details: { reason, recipe_count: product.recipe_count },
        };
        conflictingEvidence.push(evidence);
        conflicts.push({
          rule_key: seed.rule_key,
          product_id: product.product_id,
          product_name: product.product_name,
          reason,
        });
      }
    }

    candidateRules.push({
      rule_key: seed.rule_key,
      name: seed.name,
      description: seed.description,
      rule_type: "hidden_item",
      source: "deterministic",
      confidence: 0.99,
      definition: seed.definition,
      supporting_evidence: supportingEvidence,
      conflicting_evidence: conflictingEvidence,
    });
  }

  // Repeated packaging components are candidates, not active rules. Requiring
  // two products avoids turning a one-off product configuration into a rule.
  for (const pattern of packagingPatterns.filter((pattern) => pattern.product_count >= 2)) {
    const matchingUsage = baseItemUsage.get(pattern.base_item_id)!;
    candidateRules.push({
      rule_key: `discovered-packaging-${pattern.base_item_id}`,
      name: `Repeated packaging: ${pattern.name}`,
      description: `${pattern.name} appears in ${pattern.product_count} approved product recipes.`,
      rule_type: "hidden_item",
      source: "discovered",
      confidence: Math.min(0.95, 0.5 + pattern.product_count * 0.1),
      definition: {
        base_item_id: pattern.base_item_id,
        base_item_name: pattern.name,
        observed_product_count: pattern.product_count,
      },
      supporting_evidence: [...matchingUsage.productIds].map((productId) => ({
        evidence_type: "supporting",
        product_id: productId,
        base_item_id: pattern.base_item_id,
        product_name_snapshot: productNames.get(productId) ?? null,
        base_item_name_snapshot: pattern.name,
        details: { observed_in_live_recipe: true },
      })),
      conflicting_evidence: [],
    });
  }

  const recipesNeedingReview = products.flatMap((product) => {
    const reasons: string[] = [];
    const productLines = linesByProduct.get(product.product_id) ?? [];
    if (product.recipe_count === 0) reasons.push("No approved recipe");
    if (product.recipe_count > 0 && !product.main_image_url) reasons.push("Recipe has no product image for visual review");
    if (productLines.some((line) => line.base_item_status && line.base_item_status !== "active")) {
      reasons.push("Recipe includes an archived or inactive base item");
    }
    for (const conflict of conflicts) {
      if (conflict.product_id === product.product_id) reasons.push(conflict.reason);
    }
    return reasons.length > 0
      ? [{ product_id: product.product_id, product_name: product.product_name, reasons }]
      : [];
  });

  const totalProducts = products.length;
  return {
    generated_at: new Date().toISOString(),
    input_audit: {
      fields_used: [
        "products.name",
        "products.description",
        "products.description_ar",
        "products.tags",
        "catalog_categories.name",
        "products.main_image_url (availability only; no image inference)",
      ],
      translation_performed: false,
      language_availability: {
        english_name_products: products.filter((product) => /[a-z]/i.test(product.product_name)).length,
        english_description_products: products.filter((product) => /[a-z]/i.test(product.description ?? "")).length,
        arabic_description_products: products.filter((product) => /[\u0600-\u06ff]/.test(product.description_ar ?? "")).length,
        products_with_any_arabic_text: products.filter((product) =>
          /[\u0600-\u06ff]/.test(`${product.product_name} ${product.description ?? ""} ${product.description_ar ?? ""}`),
        ).length,
      },
      image_analysis: {
        available_product_images: products.filter((product) => !!product.main_image_url).length,
        policy: "format_support_only",
        enabled: false,
      },
    },
    coverage: {
      total_products: totalProducts,
      products_with_recipe: productsWithRecipe.length,
      products_without_recipe: totalProducts - productsWithRecipe.length,
      complete_recipe_count: productsWithRecipe.length,
      completeness_percent: totalProducts === 0
        ? 0
        : Number(((productsWithRecipe.length / totalProducts) * 100).toFixed(2)),
    },
    common_base_items: commonBaseItems,
    packaging_patterns: packagingPatterns,
    candidate_rules: candidateRules,
    conflicting_patterns: conflicts,
    recipes_needing_review: recipesNeedingReview,
  };
}

/** Seed the two confirmed deterministic rules for one workspace, always as approved. */
export async function ensureDeterministicRecipeRules(workspaceOwnerId: string): Promise<void> {
  for (const seed of DETERMINISTIC_RECIPE_RULES) {
    await db.query(
      `INSERT INTO recipe_rules (
         workspace_owner_id, rule_key, name, description, rule_type, source,
         status, definition, confidence
       ) VALUES ($1, $2, $3, $4, 'hidden_item', 'deterministic', 'approved', $5::jsonb, 0.9900)
       ON CONFLICT (workspace_owner_id, rule_key)
         DO UPDATE SET status = 'approved'
           WHERE recipe_rules.source = 'deterministic'
             AND recipe_rules.status = 'candidate'`,
      [
        workspaceOwnerId,
        seed.rule_key,
        seed.name,
        seed.description,
        JSON.stringify(seed.definition),
      ],
    );
  }

  const roseVariants = await db.query<{ id: number; name: string }>(
    `SELECT id, name
       FROM base_items
      WHERE workspace_owner_id = $1
        AND COALESCE(status, 'active') = 'active'
        AND archived_at IS NULL
        AND lower(name) ~ '\\mred roses?\\M'
        AND lower(name) ~ '\\m(40|60)[[:space:]]*(cm|centimeter|centimetre)s?\\M'
      ORDER BY id`,
    [workspaceOwnerId],
  );
  const byLength = (lengthCm: 40 | 60) => roseVariants.rows.filter((item) =>
    new RegExp(`\\b${lengthCm}\\s*(?:cm|centimeter|centimetre)s?\\b`, "i").test(item.name),
  );
  const contextualSeeds = [
    { key: "red-rose-flower-box-40cm", formats: ["Flower Box"], lengthCm: 40 as const },
    { key: "red-rose-wooden-shape-40cm", formats: ["Wooden Letter", "Wooden Heart"], lengthCm: 40 as const },
    { key: "red-rose-hand-bouquet-60cm", formats: ["Hand Bouquet"], lengthCm: 60 as const },
  ];
  for (const seed of contextualSeeds) {
    const variants = byLength(seed.lengthCm);
    // A contextual rule is safe to activate only when it resolves to exactly
    // one existing active Base Item in this workspace.
    if (variants.length !== 1) continue;
    const definition = {
      canonical_formats: seed.formats,
      ingredient_family: "rose",
      color: "red",
      stem_length_cm: seed.lengthCm,
      resolver_base_item_id: variants[0].id,
      precedence: 100,
      specificity: ["canonical_format", "ingredient_family", "color", "stem_length_cm"],
    };
    await db.query(
      `INSERT INTO recipe_rules (
         workspace_owner_id, rule_key, name, description, rule_type, source,
         status, definition, confidence
       ) VALUES ($1, $2, $3, $4, 'contextual_resolution', 'deterministic',
                 'approved', $5::jsonb, 0.9900)
       ON CONFLICT (workspace_owner_id, rule_key) DO NOTHING`,
      [
        workspaceOwnerId,
        seed.key,
        `${seed.formats.join(" / ")} + Red Rose resolves to ${seed.lengthCm} cm`,
        "Confirmed workspace-scoped contextual resolver using an existing Base Item ID.",
        JSON.stringify(definition),
      ],
    );
  }
}