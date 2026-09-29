import {
  CANONICAL_PRODUCT_FORMATS,
  RECIPE_SUGGESTION_PROMPT_VERSION,
  runProductionRecipeMatcher,
  type ApprovedContextualRule,
  type ProductionRecipeMatcherConfiguration,
  type ProductionRecipeMatcherRun,
  type RecipeLineInput,
  type SuggestionProduct,
} from "./recipeSuggestionEngine";

export type RecipeGenerationQueryClient = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export type RuntimeProductRow = {
  id: number;
  name: string;
  description: string | null;
  description_ar: string | null;
  main_image_url?: string | null;
  additional_image_urls?: string[] | null;
  tags: string[] | null;
  category: string | null;
  is_archived?: boolean | null;
};

export type RuntimeRecipeRow = {
  product_id: number;
  base_item_id: number;
  base_item_name: string;
  base_item_code: string | null;
  quantity: string | number;
  base_item_status?: string | null;
  base_item_archived_at?: string | null;
};

export type RuntimeBaseItemRow = {
  id: number;
  name: string;
  code: string | null;
  canonical_unit: string | null;
  category_id?: number | null;
  type?: string | null;
  package_name: string | null;
  package_quantity: string | number | null;
  approved_metadata: Record<string, unknown> | null;
  candidate_metadata?: unknown[] | null;
  approved_aliases: string[] | null;
  status?: string | null;
  archived_at?: string | null;
};

export type RuntimeRuleRow = {
  id: number;
  rule_key: string;
  name?: string;
  definition: Record<string, unknown>;
  status?: string | null;
  source?: string | null;
};

export type RecipeGenerationWorkspaceRows = {
  products: RuntimeProductRow[];
  recipes: RuntimeRecipeRow[];
  baseItems: RuntimeBaseItemRow[];
  rules: RuntimeRuleRow[];
};

const REQUIRED_OPERATIONAL_RULE_KEYS = ["flower-box-sponge", "balloon-metal-ring"] as const;

function activeStatus(status: string | null | undefined): boolean {
  return status == null || status === "active";
}

function recipeLine(row: RuntimeRecipeRow): RecipeLineInput {
  return {
    baseItemId: row.base_item_id,
    baseItemName: row.base_item_name,
    baseItemCode: row.base_item_code,
    quantity: Number(row.quantity),
  };
}

function product(row: RuntimeProductRow, recipes: RecipeLineInput[]): SuggestionProduct {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    descriptionAr: row.description_ar,
    category: row.category,
    tags: row.tags ?? [],
    recipes,
  };
}

function baseItem(row: RuntimeBaseItemRow): RecipeLineInput {
  const approvedMetadata = row.approved_metadata ?? {};
  const approvedAliases = row.approved_aliases ?? [];
  const hasApprovedMetadata = Object.keys(approvedMetadata).length > 0;
  const hasApprovedAliases = approvedAliases.length > 0;
  const hasGovernedPackage = row.package_quantity != null;
  return {
    baseItemId: row.id,
    baseItemName: row.name,
    baseItemCode: row.code,
    quantity: 1,
    metadata: hasApprovedMetadata || hasApprovedAliases || hasGovernedPackage
      ? {
          ...approvedMetadata,
          approved: hasApprovedMetadata,
          approvedAliases,
          ...(hasGovernedPackage
            ? {
                governedPackageFacts: true,
                packageName: row.package_name,
                packageSize: Number(row.package_quantity),
              }
            : {}),
        }
      : null,
  };
}

function contextualRule(row: RuntimeRuleRow): ApprovedContextualRule | null {
  const resolverBaseItemId = Number(row.definition.resolver_base_item_id);
  const canonicalFormats = Array.isArray(row.definition.canonical_formats)
    ? row.definition.canonical_formats.filter((value): value is ApprovedContextualRule["canonicalFormats"][number] =>
        typeof value === "string"
        && CANONICAL_PRODUCT_FORMATS.includes(value as ApprovedContextualRule["canonicalFormats"][number]))
    : [];
  if (!Number.isInteger(resolverBaseItemId) || resolverBaseItemId <= 0 || canonicalFormats.length === 0) return null;
  return {
    ruleId: row.id,
    ruleKey: row.rule_key,
    resolverBaseItemId,
    canonicalFormats,
    ingredientFamily: typeof row.definition.ingredient_family === "string" ? row.definition.ingredient_family : null,
    color: typeof row.definition.color === "string" ? row.definition.color : null,
    stemLengthCm: Number(row.definition.stem_length_cm) || null,
  };
}

export type RecipeGenerationRuntime = {
  candidateProducts: SuggestionProduct[];
  eligibleSupportingProducts: SuggestionProduct[];
  baseItems: RecipeLineInput[];
  baseItemRows: RuntimeBaseItemRow[];
  ruleRows: RuntimeRuleRow[];
  configuration: ProductionRecipeMatcherConfiguration;
  parityLimitations: string[];
  targetProduct(productId: number): SuggestionProduct | null;
  supportingProductsFor(productId: number): SuggestionProduct[];
  runForTarget(productId: number): {
    target: Omit<SuggestionProduct, "recipes">;
    approvedRecipe: RecipeLineInput[];
    supportingProducts: SuggestionProduct[];
    matcherRun: ProductionRecipeMatcherRun;
  } | null;
};

/**
 * The single governed eligibility and normalization boundary used by both live
 * generation and current-mode benchmarking. Candidate/unapproved metadata is
 * retained only on raw rows for diagnostics and never enters matcher inputs.
 */
export function assembleRecipeGenerationRuntime(rows: RecipeGenerationWorkspaceRows): RecipeGenerationRuntime {
  const eligibleRecipeRows = rows.recipes.filter((row) =>
    activeStatus(row.base_item_status) && row.base_item_archived_at == null);
  const recipesByProduct = new Map<number, RecipeLineInput[]>();
  for (const row of eligibleRecipeRows) {
    const lines = recipesByProduct.get(row.product_id) ?? [];
    lines.push(recipeLine(row));
    recipesByProduct.set(row.product_id, lines);
  }

  const allProductsById = new Map(rows.products.map((row) => [
    row.id,
    product(row, recipesByProduct.get(row.id) ?? []),
  ]));
  const candidateProducts = rows.products
    .filter((row) => !row.is_archived)
    .map((row) => allProductsById.get(row.id)!)
    .sort((left, right) => left.id - right.id);
  const eligibleSupportingProducts = candidateProducts.filter((candidate) => candidate.recipes.length > 0);
  const eligibleBaseItemRows = rows.baseItems
    .filter((row) => activeStatus(row.status) && row.archived_at == null)
    .sort((left, right) => left.id - right.id);
  const baseItems = eligibleBaseItemRows.map(baseItem);
  const approvedRules = rows.rules
    .filter((row) =>
      row.status === "approved"
      && (row.source === "deterministic" || row.source === "manual"))
    .sort((left, right) => left.id - right.id);
  const activeRuleKeys = new Set(approvedRules.map((rule) => rule.rule_key));
  const contextualRules = approvedRules
    .map(contextualRule)
    .filter((rule): rule is ApprovedContextualRule => rule !== null);
  const configuration: ProductionRecipeMatcherConfiguration = {
    baseItems,
    operationalRules: {
      flowerBoxSponge: activeRuleKeys.has("flower-box-sponge"),
      balloonMetalRing: activeRuleKeys.has("balloon-metal-ring"),
    },
    contextualRules,
    boundedAi: {
      policyVersion: RECIPE_SUGGESTION_PROMPT_VERSION,
      model: process.env.RECIPE_SUGGESTION_MODEL ?? "gpt-4o-mini",
      enabled: true,
    },
  };
  const roseVariantCount = (length: 40 | 60) => eligibleBaseItemRows.filter((item) =>
    /\bred\s+roses?\b/i.test(item.name)
    && new RegExp(`\\b${length}\\s*(?:cm|centimeter|centimetre)s?\\b`, "i").test(item.name)).length;
  const expectedContextualRuleKeys = [
    ...(roseVariantCount(40) === 1 ? ["red-rose-flower-box-40cm", "red-rose-wooden-shape-40cm"] : []),
    ...(roseVariantCount(60) === 1 ? ["red-rose-hand-bouquet-60cm"] : []),
  ];
  const missingRuleKeys = [...REQUIRED_OPERATIONAL_RULE_KEYS, ...expectedContextualRuleKeys]
    .filter((key) => !activeRuleKeys.has(key));
  const parityLimitations = [
    ...(missingRuleKeys.length > 0
      ? [`Approved deterministic rules are missing: ${missingRuleKeys.join(", ")}. Benchmark remained read-only and did not seed them.`]
      : []),
    "Governed approved Product-format metadata has no persisted field or approval lifecycle in the current Product schema; this evidence source is inactive for database-loaded live and benchmark Products.",
  ];

  const targetProduct = (productId: number) => allProductsById.get(productId) ?? null;
  const supportingProductsFor = (productId: number) =>
    eligibleSupportingProducts.filter((candidate) => candidate.id !== productId);
  const runForTarget = (productId: number) => {
    const withRecipe = targetProduct(productId);
    if (!withRecipe) return null;
    const { recipes, ...target } = withRecipe;
    const supportingProducts = supportingProductsFor(productId);
    return {
      target,
      approvedRecipe: recipes,
      supportingProducts,
      matcherRun: runProductionRecipeMatcher(target, supportingProducts, configuration),
    };
  };

  return {
    candidateProducts,
    eligibleSupportingProducts,
    baseItems,
    baseItemRows: eligibleBaseItemRows,
    ruleRows: approvedRules,
    configuration,
    parityLimitations,
    targetProduct,
    supportingProductsFor,
    runForTarget,
  };
}

export async function loadRecipeGenerationRuntime(
  client: RecipeGenerationQueryClient,
  workspaceOwnerId: string,
): Promise<RecipeGenerationRuntime> {
  const [products, recipes, baseItems, rules] = await Promise.all([
    client.query<RuntimeProductRow>(
      `SELECT p.id, p.name, p.description, p.description_ar, p.main_image_url, p.additional_image_urls,
              p.tags, p.category, COALESCE(p.is_archived, false) AS is_archived
         FROM products p
        WHERE p.workspace_owner_id = $1
        ORDER BY p.id ASC`,
      [workspaceOwnerId],
    ),
    client.query<RuntimeRecipeRow>(
      `SELECT pr.product_id, pr.base_item_id, bi.name AS base_item_name, bi.code AS base_item_code,
              pr.quantity::text AS quantity, bi.status AS base_item_status,
              bi.archived_at::text AS base_item_archived_at
         FROM product_recipes pr
         JOIN base_items bi ON bi.id = pr.base_item_id AND bi.workspace_owner_id = pr.workspace_owner_id
        WHERE pr.workspace_owner_id = $1
        ORDER BY pr.product_id ASC, pr.sort_order ASC, pr.id ASC`,
      [workspaceOwnerId],
    ),
    client.query<RuntimeBaseItemRow>(
      `SELECT bi.id, bi.name, bi.code, COALESCE(bip.unit, 'unit') AS canonical_unit,
              bi.category_id, bi.type, bip.name AS package_name, bip.quantity AS package_quantity,
              bi.status, bi.archived_at::text AS archived_at,
              COALESCE((
                SELECT jsonb_object_agg(candidate.attribute_type, candidate.proposed_value)
                  FROM base_item_metadata_candidates candidate
                 WHERE candidate.workspace_owner_id = bi.workspace_owner_id
                   AND candidate.base_item_id = bi.id
                   AND candidate.status = 'approved'
              ), '{}'::jsonb) AS approved_metadata,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'attribute_type', candidate.attribute_type,
                  'proposed_value', candidate.proposed_value,
                  'source_text', candidate.source_text,
                  'extraction_method', candidate.extraction_method,
                  'confidence', candidate.confidence,
                  'status', candidate.status
                ) ORDER BY candidate.id)
                  FROM base_item_metadata_candidates candidate
                 WHERE candidate.workspace_owner_id = bi.workspace_owner_id
                   AND candidate.base_item_id = bi.id
                   AND candidate.status = 'candidate'
              ), '[]'::jsonb) AS candidate_metadata,
              COALESCE((
                SELECT jsonb_agg(alias.alias ORDER BY alias.id)
                  FROM base_item_aliases alias
                 WHERE alias.workspace_owner_id = bi.workspace_owner_id
                   AND alias.base_item_id = bi.id
                   AND alias.status = 'approved'
              ), '[]'::jsonb) AS approved_aliases
         FROM base_items bi
         LEFT JOIN base_item_packages bip
           ON bip.base_item_id = bi.id AND bip.workspace_owner_id = bi.workspace_owner_id
          AND bip.is_default = true
        WHERE bi.workspace_owner_id = $1
        ORDER BY bi.id ASC`,
      [workspaceOwnerId],
    ),
    client.query<RuntimeRuleRow>(
      `SELECT id, rule_key, name, definition, status, source
         FROM recipe_rules
        WHERE workspace_owner_id = $1
        ORDER BY id ASC`,
      [workspaceOwnerId],
    ),
  ]);

  return assembleRecipeGenerationRuntime({
    products: products.rows,
    recipes: recipes.rows,
    baseItems: baseItems.rows,
    rules: rules.rows,
  });
}